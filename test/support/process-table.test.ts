// The process lists of the three systems, read the way each one gives them. The fixtures below are what macOS's
// `ps` and the Windows PowerShell script print, so the parsing and the tree walk are proved on every system;
// the last block reads the real table of the system the test runs on.

import { describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'
import { canonicalPath, parseCimTable, parsePsTable, processesUnder, readProcessTable } from './process-table.mjs'
import { collectProcessTree, findLiveElectronPids, resolveExePath } from './launch-electron.mjs'

const GPU = '/Applications/Orivon.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)'
const PS_OUTPUT = [
  '    1     0 /sbin/launchd',
  '  100     1 /Applications/Orivon.app/Contents/MacOS/Electron',
  `  101   100 ${GPU}`,
  '  102   101 /Applications/Orivon.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper',
  '  103     1 (node)',
  '  200     1 /usr/bin/ssh',
  ''
].join('\n')

const FILETIME = 133_000_000_000_000_000n
const CIM_OUTPUT = [
  '0 0 0 ',
  '4 0 0 ',
  `1000 500 ${String(FILETIME + 10n)} C:\\Program Files\\Orivon\\electron.exe`,
  `1001 1000 ${String(FILETIME + 20n)} C:\\Program Files\\Orivon\\electron.exe`,
  `1002 1001 ${String(FILETIME + 30n)} `,
  `1003 1000 ${String(FILETIME - 1_000n)} C:\\Tools\\left-behind.exe`,
  `1100 1050 ${String(FILETIME + 40n)} C:\\Program Files\\Orivon\\electron.exe`,
  ''
].join('\r\n')

function answering (output: string): { run: (file: string, args: string[]) => Promise<string>, calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = []
  return { calls, run: async (file, args) => { calls.push([file, args]); return output } }
}

describe('macOS: ps', () => {
  it('reads the parent and the full path of each process, spaces and all', () => {
    const table = parsePsTable(PS_OUTPUT)
    expect(table.get(101)).toEqual({ ppid: 100, exe: GPU })
    expect(table.get(1)).toEqual({ ppid: 0, exe: '/sbin/launchd' })
  })

  it('keeps no path for a process that ps names in parentheses', () => {
    expect(parsePsTable(PS_OUTPUT).get(103)).toEqual({ ppid: 1, exe: undefined })
  })

  it('finds a tree through ps, and asks it for pid, ppid and comm without headers', async () => {
    const { run, calls } = answering(PS_OUTPUT)
    expect((await collectProcessTree(100, { platform: 'darwin', run })).sort()).toEqual([100, 101, 102])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('/bin/ps')
    expect(calls[0]?.[1]).toContain('pid=,ppid=,comm=')
  })
})

describe('Windows: the CIM script', () => {
  it('reads the parent, the start time and the path of each process', () => {
    const table = parseCimTable(CIM_OUTPUT)
    expect(table.get(1001)).toEqual({ ppid: 1000, started: FILETIME + 20n, exe: 'C:\\Program Files\\Orivon\\electron.exe' })
    expect(table.get(1002)?.exe).toBeUndefined()
    expect(table.get(4)).toEqual({ ppid: 0, started: 0n, exe: undefined })
  })

  it('reads output that begins with a byte order mark', () => {
    expect(parseCimTable(`\uFEFF${CIM_OUTPUT}`).get(1000)?.ppid).toBe(500)
  })

  it('runs PowerShell with a script that asks for Win32_Process, encoded so no quoting can change it', async () => {
    const { run, calls } = answering(CIM_OUTPUT)
    await readProcessTable({ platform: 'win32', run })
    const [file, args] = calls[0] ?? ['', []]
    expect(file.toLowerCase()).toMatch(/powershell\.exe$/)
    const encoded = args[args.indexOf('-EncodedCommand') + 1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain('Win32_Process')
    expect(args).toContain('-NoProfile')
  })

  it('walks the tree and leaves out a process that started before the parent whose pid it names', async () => {
    const { run } = answering(CIM_OUTPUT)
    expect((await collectProcessTree(1000, { platform: 'win32', run })).sort()).toEqual([1000, 1001, 1002])
  })

  it('still finds the children of a root that has already exited, which Windows leaves pointing at it', async () => {
    const { run } = answering(CIM_OUTPUT)
    expect((await collectProcessTree(1050, { platform: 'win32', run })).sort()).toEqual([1050, 1100])
  })

  it('names the path a process runs, and reports an Electron binary as a live one', async () => {
    const { default: electronPath } = await import('electron')
    const table = `7 1 ${String(FILETIME)} ${electronPath}\r\n8 1 ${String(FILETIME)} C:\\Orivon\\not-installed\\other.exe\r\n`
    const { run } = answering(table)
    expect(await findLiveElectronPids([7, 8, 9], { platform: 'win32', run })).toEqual([7])
    expect(await resolveExePath(8, { platform: 'win32', run })).toBe('C:\\Orivon\\not-installed\\other.exe')
    expect(await resolveExePath(9, { platform: 'win32', run })).toBeUndefined()
  })
})

describe('a system whose list cannot be read', () => {
  it('falls back to the one pid held, and says why in the log when the tool fails', async () => {
    const failing = async (): Promise<string> => { throw new Error('injected: no such tool') }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await collectProcessTree(55, { platform: 'darwin', run: failing })).toEqual([55])
      expect(await findLiveElectronPids([55], { platform: 'win32', run: failing })).toEqual([])
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([expect.stringContaining('[process-table] reading the processes of darwin failed')]))
    } finally {
      log.mockRestore()
    }
  })

  it('has no list for a system it does not know', async () => {
    expect(await readProcessTable({ platform: 'aix' })).toBeUndefined()
  })
})

describe('processesUnder', () => {
  it('does not depend on the order the table lists a child and its parent in', () => {
    const table = new Map([[3, { ppid: 2 }], [2, { ppid: 1 }], [1, { ppid: 0 }], [9, { ppid: 8 }]])
    expect(processesUnder(table, 1).sort()).toEqual([1, 2, 3])
  })
})

describe('the real table of this system', () => {
  it('lists this very process under the parent Node reports, with the binary it runs', async () => {
    const table = await readProcessTable()
    expect(table).toBeDefined()
    const own = table?.get(process.pid)
    expect(own?.ppid).toBe(process.ppid)
    expect(await canonicalPath(own?.exe ?? '')).toBe(await realpath(process.execPath))
  })
})
