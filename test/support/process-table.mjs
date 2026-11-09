// The running processes of the system the suite is on, for the teardown in launch-electron.mjs: who is whose
// child, and which binary each one runs. Each system has its own source and none needs a native module:
// /proc on Linux, `ps` on macOS, PowerShell's CIM view of Win32_Process on Windows.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * One process. `started` grows with the start time and is set only where the system reports it, because only
 * Windows leaves an orphan pointing at the pid of its dead parent, which a new process can then take over.
 * @typedef {{ ppid: number, exe?: string, started?: bigint }} ProcessEntry
 */

/**
 * Runs a program and resolves to its stdout; a unit test injects one that answers from a fixture.
 * @typedef {(file: string, args: string[]) => Promise<string>} RunTool
 */

/**
 * @typedef {object} TableOptions
 * @property {string} [procRoot] Read this directory as a /proc, whatever the system: a fixture in a unit test.
 * @property {NodeJS.Platform} [platform]
 * @property {RunTool} [run]
 */

const TOOL_TIMEOUT_MS = 30_000

/** One line per process: pid, parent pid, start as a FILETIME, then the executable's path (empty when unreadable). */
const CIM_SCRIPT = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath | ForEach-Object {',
  '  $started = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }',
  "  '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $started, $_.ExecutablePath",
  '}'
].join('\n')

/** @type {RunTool} */
function runTool (file, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolve(stdout)
      else reject(error)
    })
    // PowerShell waits for a stdin that never closes when it is left open.
    child.stdin?.end()
  })
}

async function readProcFs (procRoot) {
  let entries
  try {
    entries = await readdir(procRoot)
  } catch {
    return undefined
  }
  const table = new Map()
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const status = await readFile(join(procRoot, entry, 'status'), 'utf8').catch(() => '')
    const ppid = /^PPid:\s*(\d+)/m.exec(status)?.[1]
    if (ppid === undefined) return
    const exe = await readlink(join(procRoot, entry, 'exe')).catch(() => undefined)
    table.set(Number(entry), { ppid: Number(ppid), exe })
  }))
  return table
}

/**
 * `ps -A -o pid=,ppid=,comm=`: macOS prints the executable's full path as `comm`, spaces included, so it is
 * the last column.
 *
 * @param {string} text
 * @returns {Map<number, ProcessEntry>}
 */
export function parsePsTable (text) {
  const table = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
    if (match === null) continue
    // A zombie or a kernel task has a name in parentheses, not a path.
    table.set(Number(match[1]), { ppid: Number(match[2]), exe: match[3]?.startsWith('/') ? match[3] : undefined })
  }
  return table
}

/**
 * The output of CIM_SCRIPT.
 *
 * @param {string} text
 * @returns {Map<number, ProcessEntry>}
 */
export function parseCimTable (text) {
  const table = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\uFEFF?(\d+) (\d+) (\d+) ?(.*?)\s*$/.exec(line)
    if (match === null) continue
    const exe = match[4]
    table.set(Number(match[1]), { ppid: Number(match[2]), started: BigInt(match[3]), exe: exe === '' ? undefined : exe })
  }
  return table
}

function powershellPath () {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Every process on the system, or undefined when this system's source cannot be read; a failing tool is
 * logged, so a run's log says why the teardown fell back to the one pid it holds.
 *
 * @param {TableOptions} [options]
 * @returns {Promise<Map<number, ProcessEntry> | undefined>}
 */
export async function readProcessTable ({ procRoot, platform = process.platform, run = runTool } = {}) {
  try {
    if (procRoot !== undefined) return await readProcFs(procRoot)
    if (platform === 'linux') return await readProcFs('/proc')
    if (platform === 'darwin') return parsePsTable(await run('/bin/ps', ['-ww', '-A', '-o', 'pid=,ppid=,comm=']))
    if (platform === 'win32') {
      const script = Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64')
      return parseCimTable(await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', script]))
    }
  } catch (error) {
    console.error(`[process-table] reading the processes of ${platform} failed:`, error)
  }
  return undefined
}

/**
 * `rootPid` and every process below it. A fixpoint, not one pass in table order, because a child can be
 * listed before the parent that qualifies it. A process that started before its parent is not its child: that
 * parent's pid is a recycled one.
 *
 * @param {Map<number, ProcessEntry>} table
 * @param {number} rootPid
 * @returns {number[]}
 */
export function processesUnder (table, rootPid) {
  const tree = new Set([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, { ppid, started }] of table) {
      if (tree.has(pid) || !tree.has(ppid)) continue
      const parentStarted = table.get(ppid)?.started
      if (started !== undefined && parentStarted !== undefined && started < parentStarted) continue
      tree.add(pid)
      grew = true
    }
  }
  return [...tree]
}

const realpathNative = promisify(realpath.native)

/**
 * The path as the file system spells it: links followed, and on Windows the long names and the real
 * letter case, so two spellings of one binary compare equal. A path that cannot be resolved is returned as given.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function canonicalPath (path) {
  try {
    return await realpathNative(path)
  } catch {
    return path
  }
}
