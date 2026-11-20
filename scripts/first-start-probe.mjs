/**
 * Times how long a packaged Orivon takes to show itself after a click, from outside, so it works on any build
 * (an installed deb, an AppImage, the NSIS install, a mounted or copied dmg app) and on every system.
 *
 * Usage: node scripts/run-headless.mjs node scripts/first-start-probe.mjs <executable> [--runs N] [--json <file>]
 *          [--label <text>] [--offline] [-- extra app arguments]
 *
 * Two series of N launches each (default 5), every launch on a throwaway profile and asked to quit when measured:
 *   first start  a new profile each launch, with the welcome screen and defaults a package has, as a first click gets
 *   next start   one profile; a first launch that is not counted, then N launches on it
 * A launch is timed from just before the spawn to the first poll (every 25 ms) that sees the shell page rendered, and
 * to the first that sees the bundled extension running. When the build prints its own one-line record,
 * `[orivon][startup] {json}`, the record is kept as printed and its numbers are summarized too; a build that prints none
 * is timed all the same. A launch that does not quit when asked within QUIT_WAIT_MS is killed, and the report says so:
 * the next launch on that profile then starts as after a crash, which is not the start a click gets. `--offline` keeps the launch off the network (smoke-packaged.mjs NETWORK_OFF_ENV), which is
 * steadier and not what a person's launch does. Prints a table; `--json` also writes every raw value.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'
import {
  NETWORK_OFF_ENV, QUIET_ENV, STARTUP_TIMEOUT_MS, launchPackaged, stop, waitForBundledExtension, waitForShell
} from './smoke-packaged.mjs'

export const DEFAULT_RUNS = 5
export const MAX_RUNS = 50
/** How often the app is asked whether the shell has rendered and the extension runs. */
export const POLL_MS = 25
/** How long after both are seen the app is given to print its own record. */
export const RECORD_WAIT_MS = 2000
/** How long a launch is given to quit when asked before it is killed. */
export const QUIT_WAIT_MS = 15_000

const USAGE = `usage: node scripts/run-headless.mjs node scripts/first-start-probe.mjs <executable> [--runs N] [--json <file>] [--label <text>] [--offline] [-- extra app arguments]`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {string[]} argv the arguments after the script's name
 * @returns {{ executable: string, runs: number, json: string | undefined, label: string | undefined, offline: boolean, appArgs: string[] }}
 */
export function parseArgs (argv) {
  const split = argv.indexOf('--')
  const own = split === -1 ? argv : argv.slice(0, split)
  const appArgs = split === -1 ? [] : argv.slice(split + 1)
  const out = { executable: '', runs: DEFAULT_RUNS, json: undefined, label: undefined, offline: false, appArgs }
  const positional = []
  for (let at = 0; at < own.length; at++) {
    const word = own[at]
    if (word === '--offline') out.offline = true
    else if (word === '--runs' || word === '--json' || word === '--label') {
      const value = own[++at]
      if (value === undefined) throw new Error(`${word} needs a value`)
      if (word === '--json') out.json = value
      else if (word === '--label') out.label = value
      else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_RUNS) out.runs = Number(value)
      else throw new Error(`--runs takes a whole number from 1 to ${MAX_RUNS}, not ${value}`)
    } else if (word.startsWith('-')) throw new Error(`unknown switch ${word}`)
    else positional.push(word)
  }
  if (positional.length !== 1) throw new Error(positional.length === 0 ? 'no executable given' : `one executable, not ${positional.length}: ${positional.join(' ')}`)
  out.executable = positional[0]
  return out
}

/** The first `[orivon][startup] {json}` line of the app's output that holds a JSON object, parsed; undefined when there is none yet. */
export function parseStartupRecord (output) {
  for (const line of output.split('\n')) {
    const found = /^\[orivon\]\[startup\] (\{.*\})\s*$/.exec(line.replace(/\r$/, ''))
    if (found === null) continue
    try {
      const record = JSON.parse(found[1])
      if (record !== null && typeof record === 'object' && !Array.isArray(record)) return record
    } catch {}
  }
  return undefined
}

/** Every finite number of a record, by its path: `{ a: { b: 3 }, c: 4 }` gives `{ 'a.b': 3, c: 4 }`. */
export function numericLeaves (value, prefix = '') {
  /** @type {Record<string, number>} */
  const out = {}
  if (typeof value === 'number' && Number.isFinite(value)) out[prefix] = value
  else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) Object.assign(out, numericLeaves(inner, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

/** The median (a whole number of ms for whole inputs: the mean of the two middle values rounded), minimum and maximum. */
export function stats (values) {
  if (values.length === 0) return { n: 0, median: undefined, min: undefined, max: undefined }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  return { n: sorted.length, median, min: sorted[0], max: sorted[sorted.length - 1] }
}

/**
 * The statistics of each measure over the launches that worked: `shellMs`, `extensionMs`, and every number the app's own
 * record held in each of them, as `startup.<path>`.
 * @param {Array<{ shellMs?: number, extensionMs?: number, record?: object, error?: string }>} runs
 */
export function seriesStats (runs) {
  const worked = runs.filter((run) => run.error === undefined)
  /** @type {Record<string, number[]>} */
  const columns = { shellMs: [], extensionMs: [] }
  for (const run of worked) {
    columns.shellMs.push(run.shellMs)
    columns.extensionMs.push(run.extensionMs)
    for (const [path, number] of Object.entries(numericLeaves(run.record))) (columns[`startup.${path}`] ??= []).push(number)
  }
  return Object.fromEntries(Object.entries(columns).filter(([, values]) => values.length > 0).map(([name, values]) => [name, stats(values)]))
}

const MEASURE_NAMES = { shellMs: 'shell page rendered', extensionMs: 'bundled extension running' }

/**
 * A text table of the series, one row per measure: launches that worked out of those asked for, median, minimum and maximum in ms.
 * @param {Array<{ title: string, stats: ReturnType<typeof seriesStats> }>} series
 * @param {number} runs launches asked for in each series
 */
export function formatTable (series, runs) {
  const rows = [['series', 'measure', 'n', 'median', 'min', 'max']]
  for (const entry of series) {
    const names = Object.keys(entry.stats)
    if (names.length === 0) rows.push([entry.title, '(no launch worked)', `0/${runs}`, '-', '-', '-'])
    names.forEach((name, at) => {
      const row = entry.stats[name]
      rows.push([at === 0 ? entry.title : '', MEASURE_NAMES[name] ?? name, `${row.n}/${runs}`, String(row.median), String(row.min), String(row.max)])
    })
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  const line = (row) => row.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ').trimEnd()
  return [line(rows[0]), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.slice(1).map(line)].join('\n')
}

/** The text a finished probe prints, from what `--json` writes: a heading and the table, with every failed launch named. */
export function formatReport (result) {
  const heading = `${result.label ?? result.executable}${result.appVersion === undefined ? '' : ` ${result.appVersion}`} on ${result.os.platform} ${result.os.arch} (ms, ${result.date})`
  const series = [{ title: 'first start', entry: result.first }, { title: 'next start', entry: result.next }]
  const failures = series.flatMap(({ title, entry }) => [
    ...(entry.warmup?.error === undefined ? [] : [`${title} warm-up: ${entry.warmup.error}`]),
    ...entry.runs.flatMap((run, at) => (run.error === undefined ? [] : [`${title} launch ${at + 1}: ${run.error}`]))
  ])
  // Only the next-start series reuses a profile, so only there does a kill change what the following launch measures.
  const killed = [result.next.warmup, ...result.next.runs].filter((run) => run?.ended === 'killed').length
  const notes = killed === 0 ? [] : [`NOTE next start: ${killed} launch(es) did not quit when asked and were killed, so the launch after each started as after a crash`]
  return [heading, formatTable(series.map(({ title, entry }) => ({ title, stats: entry.stats })), result.runsPerSeries), ...notes, ...failures.map((failure) => `FAILED ${failure}`)].join('\n')
}

/**
 * One file of an asar archive, read without Electron: the archive opens with its header's size and the header,
 * a JSON tree of the files and where each starts after it.
 * @returns {Buffer | undefined} undefined when the archive or the file is not there
 */
export function readAsarFile (asarPath, file) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const lead = Buffer.alloc(16)
    readSync(fd, lead, 0, 16, 0)
    const base = 8 + lead.readUInt32LE(4)
    const json = Buffer.alloc(lead.readUInt32LE(12))
    readSync(fd, json, 0, json.length, 16)
    const entry = file.split('/').reduce((node, part) => node?.files?.[part], JSON.parse(json.toString('utf8')))
    if (entry === undefined || entry.size === undefined || entry.offset === undefined) return undefined
    const data = Buffer.alloc(entry.size)
    readSync(fd, data, 0, entry.size, base + Number(entry.offset))
    return data
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The version in the package's `package.json`, found beside an unpacked or installed executable; undefined for an AppImage. */
export function appVersionOf (executable) {
  const beside = [join(dirname(executable), 'resources', 'app.asar'), join(dirname(executable), '..', 'Resources', 'app.asar')]
  for (const asar of beside) {
    const data = readAsarFile(asar, 'package.json')
    if (data === undefined) continue
    try { return JSON.parse(data.toString('utf8')).version } catch {}
  }
  return undefined
}

/** Resolves with the app's own record once it has printed one, or undefined after `waitMs` or once the app has gone. */
async function waitForRecord (child, output, waitMs) {
  for (const deadline = Date.now() + waitMs; ; await sleep(50)) {
    const record = parseStartupRecord(output())
    if (record !== undefined) return record
    if (Date.now() >= deadline || child.exitCode !== null || child.signalCode !== null) return undefined
  }
}

/** One launch on `profile`: its times in ms from the spawn, the app's own record when it printed one, or the reason it failed. */
async function launchOnce (executable, profile, { env, appArgs }) {
  const t0 = performance.now()
  const { child, output } = launchPackaged(executable, { profile, env, args: appArgs })
  const since = () => Math.round(performance.now() - t0)
  let run
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    const [shellMs, extensionMs] = await Promise.all([
      waitForShell(child, output, deadline, POLL_MS).then(since),
      waitForBundledExtension(child, output, deadline, POLL_MS).then(since)
    ])
    const record = await waitForRecord(child, output, RECORD_WAIT_MS)
    run = record === undefined ? { shellMs, extensionMs } : { shellMs, extensionMs, record }
  } catch (error) {
    run = { error: error.message, appOutput: output().split('\n').slice(-20).join('\n') }
  }
  return { ...run, ended: await quit(child) }
}

/**
 * The browser process among `root` and its descendants: a launcher (a shell script, the AppImage's runtime) can stand
 * between the probe and Electron, and only the browser process takes SIGTERM as a quit. It is the parent of a
 * Chromium helper (an argument `--type=...`) that is no helper itself; `root` when no such process is seen.
 * @param {number} root
 * @param {Array<{ pid: number, ppid: number, args: string }>} table
 */
export function browserPid (root, table) {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]))
  const isHelper = (entry) => entry.args.split(/\s+/).some((arg) => arg.startsWith('--type='))
  const under = (pid) => {
    for (let at = byPid.get(pid), steps = 0; at !== undefined && steps < table.length; at = byPid.get(at.ppid), steps++) if (at.pid === root) return true
    return false
  }
  for (const entry of table) {
    const parent = byPid.get(entry.ppid)
    if (isHelper(entry) && parent !== undefined && !isHelper(parent) && under(parent.pid)) return parent.pid
  }
  return root
}

/** Every process with its parent and arguments, from `ps`; empty when `ps` cannot be run. */
function processTable () {
  const listed = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  return (listed.stdout ?? '').split('\n').flatMap((line) => {
    const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return found === null ? [] : [{ pid: Number(found[1]), ppid: Number(found[2]), args: found[3] }]
  })
}

/**
 * Asks the app to quit as a person's quit does (SIGTERM to its browser process, which Electron takes as a quit; on
 * Windows a close without /F), so it saves its session as ended cleanly; kills it only if it is still running after
 * QUIT_WAIT_MS. Whatever a launcher left behind in the launch's process group is killed either way.
 * @returns {Promise<'quit' | 'killed'>}
 */
async function quit (child) {
  const gone = () => child.pid === undefined || child.exitCode !== null || child.signalCode !== null
  if (gone()) return 'quit'
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid)], { stdio: 'ignore' })
  else try { process.kill(browserPid(child.pid, processTable()), 'SIGTERM') } catch {}
  for (let waited = 0; !gone() && waited < QUIT_WAIT_MS; waited += 250) await sleep(250)
  const ended = gone() ? 'quit' : 'killed'
  await stop(child)
  if (process.platform !== 'win32') try { process.kill(-child.pid, 'SIGKILL') } catch {}
  return ended
}

function removeProfile (profile) {
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }) } catch (error) { console.error(`[first-start-probe] could not remove ${profile}: ${error.message}`) }
}

function progress (title, at, total, run) {
  console.log(`[first-start-probe] ${title} ${at}/${total}: ${run.error === undefined ? `shell ${run.shellMs} ms, extension ${run.extensionMs} ms${run.record === undefined ? '' : ', startup record'}` : `FAILED ${run.error}`}`)
}

/** N launches, each on a new profile. */
async function firstStartSeries (executable, runs, options) {
  const results = []
  for (let at = 1; at <= runs; at++) {
    const profile = mkdtempSync(join(tmpdir(), 'orivon-first-start-'))
    try { results.push(await launchOnce(executable, profile, options)) } finally { removeProfile(profile) }
    progress('first start', at, runs, results[at - 1])
  }
  return { runs: results, stats: seriesStats(results) }
}

/** One profile: a launch that is not counted, then N that are. A warm-up that fails ends the series. */
async function nextStartSeries (executable, runs, options) {
  const profile = mkdtempSync(join(tmpdir(), 'orivon-next-start-'))
  try {
    const warmup = await launchOnce(executable, profile, options)
    progress('next start warm-up', 1, 1, warmup)
    if (warmup.error !== undefined) return { warmup, runs: [], stats: {} }
    const results = []
    for (let at = 1; at <= runs; at++) {
      results.push(await launchOnce(executable, profile, options))
      progress('next start', at, runs, results[at - 1])
    }
    return { warmup, runs: results, stats: seriesStats(results) }
  } finally {
    removeProfile(profile)
  }
}

/** The probe's whole result, the object `--json` writes. */
export async function probe (executable, { runs = DEFAULT_RUNS, label, offline = false, appArgs = [] } = {}) {
  const env = { ...QUIET_ENV, ...(offline ? NETWORK_OFF_ENV : {}) }
  const options = { env, appArgs }
  const first = await firstStartSeries(executable, runs, options)
  const next = await nextStartSeries(executable, runs, options)
  return {
    date: new Date().toISOString(),
    os: { platform: platform(), release: release(), arch: arch() },
    executable,
    label,
    appVersion: appVersionOf(executable),
    runsPerSeries: runs,
    offline,
    appArgs,
    first,
    next
  }
}

/** Whether any launch of the result failed, the warm-up included. */
export function anyFailed (result) {
  return [result.first, result.next].some((entry) => entry.warmup?.error !== undefined || entry.runs.some((run) => run.error !== undefined))
}

if (isInvokedDirectly(import.meta.url)) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[first-start-probe] ${error.message}\n${USAGE}`)
    process.exit(2)
  }
  const result = await probe(options.executable, options)
  console.log(`\n${formatReport(result)}`)
  if (options.json !== undefined) {
    mkdirSync(dirname(options.json), { recursive: true })
    writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`)
  }
  process.exit(anyFailed(result) ? 1 : 0)
}
