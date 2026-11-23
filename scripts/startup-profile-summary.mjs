/**
 * Reads a CPU profile of Orivon's start (`ORIVON_STARTUP_PROFILE=<file>`, or one made with DevTools) in the terminal: how
 * the time went in the whole profile or in a window of it, as the functions that spent it and the files or packages they
 * live in.
 *
 * Usage: node scripts/startup-profile-summary.mjs <file.cpuprofile> [--from-ms N] [--to-ms M] [--top K]
 *
 * `--from-ms` and `--to-ms` are on the clock of the start-up line, `[orivon][startup] {json}`: milliseconds since the
 * system created the process, so `--from-ms <afterWindowDone> --to-ms <storesLoaded>` reads what ran between those two
 * marks of the same launch. A profile made by Orivon says where it began on that clock; any other profile has no such
 * anchor, and the window then counts from the profile's own start. Self time is the time a function itself ran; total
 * time includes what it called. `(idle)` is the event loop waiting, `(program)` native code outside JavaScript.
 */
import { readFileSync } from 'node:fs'
import { isInvokedDirectly } from './cli.mjs'

export const DEFAULT_TOP = 15
const PSEUDO = new Set(['(root)', '(program)', '(idle)', '(garbage collector)'])
const USAGE = 'usage: node scripts/startup-profile-summary.mjs <file.cpuprofile> [--from-ms N] [--to-ms M] [--top K]'

/**
 * @param {string[]} argv the arguments after the script's name
 * @returns {{ file: string, fromMs: number | undefined, toMs: number | undefined, top: number }}
 */
export function parseArgs (argv) {
  const out = { file: '', fromMs: undefined, toMs: undefined, top: DEFAULT_TOP }
  const positional = []
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]
    if (word === '--from-ms' || word === '--to-ms' || word === '--top') {
      const value = argv[++at]
      if (value === undefined || !/^\d+(\.\d+)?$/.test(value)) throw new Error(`${word} takes a number, not ${value ?? 'nothing'}`)
      if (word === '--top') out.top = Math.max(1, Math.floor(Number(value)))
      else if (word === '--from-ms') out.fromMs = Number(value)
      else out.toMs = Number(value)
    } else if (word.startsWith('-')) throw new Error(`unknown switch ${word}`)
    else positional.push(word)
  }
  if (positional.length !== 1) throw new Error(positional.length === 0 ? 'no profile given' : `one profile, not ${positional.length}: ${positional.join(' ')}`)
  out.file = positional[0]
  if (out.fromMs !== undefined && out.toMs !== undefined && out.toMs <= out.fromMs) throw new Error(`--to-ms ${out.toMs} is not after --from-ms ${out.fromMs}`)
  return out
}

/** A file's path in a profile, shortened to what tells it apart: the part inside the app archive, or its last three folders. */
export function shortPath (url) {
  if (url === '') return ''
  let path = url
  if (/^file:/.test(path)) { try { path = decodeURIComponent(new URL(path).pathname) } catch { path = path.replace(/^file:\/+/, '/') } }
  path = path.replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1')
  const inside = /\/app\.asar(?:\.unpacked)?\/(.*)$/.exec(path)
  if (inside !== null) return inside[1]
  const parts = path.split('/')
  return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : path
}

/** What a function belongs to: a package, Node, Electron, a file of the app, or a name V8 gives work that is not a function. */
export function groupOf (functionName, url) {
  if (PSEUDO.has(functionName)) return functionName
  if (url === '') return '(native)'
  if (url.startsWith('node:')) return url.startsWith('node:internal/') ? 'node:internal' : url.split('/')[0]
  if (url.startsWith('electron/js2c/')) return 'electron:js2c'
  const found = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url.replace(/\\/g, '/'))
  if (found !== null) return `node_modules/${found[1]}`
  return shortPath(url)
}

function keyOf (frame) {
  return `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`
}

/**
 * The time a profile spent, by function and by group, inside a window.
 * @param {object} profile a parsed `.cpuprofile`: nodes, startTime, endTime, samples, timeDeltas, and optionally Orivon's `orivon` anchor
 * @param {{ fromMs?: number, toMs?: number }} [window] on the start-up line's clock when the profile is anchored, else from the profile's start
 */
export function summarizeProfile (profile, { fromMs, toMs } = {}) {
  const { nodes, samples, timeDeltas } = profile
  const anchor = profile.orivon?.startMs
  const anchored = typeof anchor === 'number'
  const originMs = anchored ? anchor : 0
  const profileMs = (profile.endTime - profile.startTime) / 1000
  const from = fromMs ?? originMs
  const to = toMs ?? originMs + profileMs + 1

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of nodes) for (const child of node.children ?? []) parent.set(child, node.id)

  const functions = new Map()
  const entry = (frame) => {
    const key = keyOf(frame)
    let found = functions.get(key)
    if (found === undefined) {
      found = { name: frame.functionName === '' ? '(anonymous)' : frame.functionName, url: frame.url, line: frame.lineNumber + 1, selfMs: 0, totalMs: 0, group: groupOf(frame.functionName, frame.url) }
      functions.set(key, found)
    }
    return found
  }
  // The distinct functions on the stack of each node, computed once: a sample counts for each of them once, so a
  // function that recurses is not counted twice.
  const stacks = new Map()
  const stackOf = (id) => {
    let found = stacks.get(id)
    if (found === undefined) {
      const seen = new Set()
      found = []
      for (let at = id; at !== undefined; at = parent.get(at)) {
        const frame = byId.get(at)?.callFrame
        if (frame === undefined) continue
        const key = keyOf(frame)
        if (!seen.has(key)) { seen.add(key); found.push(entry(frame)) }
      }
      stacks.set(id, found)
    }
    return found
  }

  let atUs = profile.startTime
  let counted = 0
  let totalMs = 0
  const groups = new Map()
  const idle = { idleMs: 0, programMs: 0, gcMs: 0 }
  for (let at = 0; at < samples.length; at++) {
    atUs += timeDeltas[at] ?? 0
    const nextUs = at + 1 < samples.length ? atUs + (timeDeltas[at + 1] ?? 0) : Math.max(atUs, profile.endTime)
    const weight = (nextUs - atUs) / 1000
    const clock = originMs + (atUs - profile.startTime) / 1000
    if (clock < from || clock >= to) continue
    const node = byId.get(samples[at])
    if (node === undefined) continue
    counted++
    totalMs += weight
    const own = entry(node.callFrame)
    own.selfMs += weight
    groups.set(own.group, (groups.get(own.group) ?? 0) + weight)
    if (own.name === '(idle)') idle.idleMs += weight
    else if (own.name === '(program)') idle.programMs += weight
    else if (own.name === '(garbage collector)') idle.gcMs += weight
    for (const frame of stackOf(node.id)) frame.totalMs += weight
  }

  const list = [...functions.values()]
  return {
    anchored,
    base: profile.orivon?.base ?? null,
    stoppedBecause: profile.orivon?.stoppedBecause ?? null,
    profileMs,
    originMs,
    from,
    to: Math.min(to, originMs + profileMs),
    samples: counted,
    totalMs,
    ...idle,
    bySelf: list.filter((fn) => fn.selfMs > 0 && fn.name !== '(root)').sort((a, b) => b.selfMs - a.selfMs),
    byTotal: list.filter((fn) => fn.totalMs > 0 && fn.name !== '(root)').sort((a, b) => b.totalMs - a.totalMs),
    byGroup: [...groups.entries()].map(([group, selfMs]) => ({ group, selfMs })).sort((a, b) => b.selfMs - a.selfMs)
  }
}

const ms = (value) => value.toFixed(1)

/** A table: the right-aligned numbers first, then the text columns, which are cut to `width`. */
function table (header, rows) {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)))
  const line = (row) => row.map((cell, column) => (column < 2 ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ').trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

/** The text a summary prints. */
export function formatSummary (summary, { file, top = DEFAULT_TOP } = {}) {
  const pct = (value) => (summary.totalMs === 0 ? '0.0' : ((100 * value) / summary.totalMs).toFixed(1))
  const clock = summary.anchored
    ? `ms on the start-up line's clock (${summary.base === 'process-creation' ? 'since the process was created' : 'since the performance clock began'})`
    : 'ms from the profile\'s start (it carries no start-up line anchor)'
  const where = (fn) => (fn.url === '' ? '' : `${shortPath(fn.url)}:${fn.line}`)
  const self = summary.bySelf.slice(0, top).map((fn) => [ms(fn.selfMs), pct(fn.selfMs), fn.name, where(fn)])
  const total = summary.byTotal.filter((fn) => !PSEUDO.has(fn.name)).slice(0, top).map((fn) => [ms(fn.totalMs), pct(fn.totalMs), fn.name, where(fn)])
  const groups = summary.byGroup.slice(0, top).map(({ group, selfMs }) => [ms(selfMs), pct(selfMs), group, ''])
  return [
    `${file === undefined ? 'profile' : file}: ${ms(summary.profileMs)} ms profiled${summary.stoppedBecause === null ? '' : `, stopped because ${summary.stoppedBecause}`}`,
    `window: ${ms(summary.from)} to ${ms(summary.to)} ${clock}`,
    `${ms(summary.totalMs)} ms in ${summary.samples} samples: idle ${ms(summary.idleMs)} ms (${pct(summary.idleMs)}%), native outside JavaScript ${ms(summary.programMs)} ms (${pct(summary.programMs)}%), garbage collection ${ms(summary.gcMs)} ms (${pct(summary.gcMs)}%)`,
    '',
    `Self time, top ${self.length}`,
    table(['ms', '%', 'function', 'where'], self),
    '',
    `Total time (the function and what it called), top ${total.length}`,
    table(['ms', '%', 'function', 'where'], total),
    '',
    `Self time by file or package, top ${groups.length}`,
    table(['ms', '%', 'file or package', ''], groups)
  ].join('\n')
}

if (isInvokedDirectly(import.meta.url)) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[startup-profile-summary] ${error.message}\n${USAGE}`)
    process.exit(2)
  }
  let profile
  try {
    profile = JSON.parse(readFileSync(options.file, 'utf8'))
    if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)) throw new Error('not a .cpuprofile: it has no nodes, samples and timeDeltas')
  } catch (error) {
    console.error(`[startup-profile-summary] ${options.file}: ${error.message}`)
    process.exit(1)
  }
  console.log(formatSummary(summarizeProfile(profile, options), { file: options.file, top: options.top }))
}
