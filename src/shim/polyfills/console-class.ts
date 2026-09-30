// `console.Console`: a console over a pair of writable streams, as Node's is. Every
// method is bound to its instance, each write looks the stream's `write` up as it
// happens (so a program that patches `process.stdout.write` sees what a console
// writes), and a failing stream is ignored unless `ignoreErrors` is false.

import { format, inspect } from 'util'
import { renderTable } from './console-table.js'

export interface WritableLike { write: (chunk: string, callback?: (error?: Error | null) => void) => unknown }

export interface ConsoleOptions {
  stdout: WritableLike
  stderr?: WritableLike
  ignoreErrors?: boolean
  inspectOptions?: object
  groupIndentation?: number
}

const MINUTE = 60_000
const HOUR = 3_600_000

/** Node's rendering of an elapsed time: milliseconds, seconds, or h:m:ss.mmm once a minute has passed. */
function formatTime (elapsed: number): string {
  let ms = elapsed
  let hours = 0
  let minutes = 0
  let seconds = 0
  if (ms >= 1000) {
    if (ms >= MINUTE) {
      if (ms >= HOUR) { hours = Math.floor(ms / HOUR); ms %= HOUR }
      minutes = Math.floor(ms / MINUTE)
      ms %= MINUTE
    }
    seconds = ms / 1000
  }
  if (hours !== 0 || minutes !== 0) {
    const [whole = '0', fraction = '000'] = seconds.toFixed(3).split('.')
    const lead = hours !== 0 ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes)
    return `${lead}:${whole.padStart(2, '0')}.${fraction} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`
  }
  if (seconds !== 0) return `${seconds.toFixed(3)}s`
  return `${Number(ms.toFixed(3))}ms`
}

function warn (message: string): void {
  globalThis.process.emitWarning(message)
}

export class Console {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
  dir: (value?: unknown, options?: object) => void
  dirxml: (...args: unknown[]) => void
  table: (data?: unknown, properties?: readonly string[]) => void
  assert: (condition?: unknown, ...args: unknown[]) => void
  count: (label?: unknown) => void
  countReset: (label?: unknown) => void
  group: (...labels: unknown[]) => void
  groupCollapsed: (...labels: unknown[]) => void
  groupEnd: () => void
  time: (label?: unknown) => void
  timeEnd: (label?: unknown) => void
  timeLog: (label?: unknown, ...data: unknown[]) => void

  constructor (options: ConsoleOptions | WritableLike, errorStream?: WritableLike) {
    const given: ConsoleOptions = 'stdout' in options ? options : { stdout: options, ...(errorStream === undefined ? {} : { stderr: errorStream }) }
    if (typeof given.stdout?.write !== 'function') {
      throw Object.assign(new TypeError('The "stdout" argument must be an instance of Writable or have a write method.'), { code: 'ERR_CONSOLE_WRITABLE_STREAM' })
    }
    const stdout = given.stdout
    const stderr = given.stderr ?? stdout
    const ignoreErrors = given.ignoreErrors !== false
    const inspectOptions = given.inspectOptions ?? {}
    const groupStep = ' '.repeat(given.groupIndentation ?? 2)
    let indent = ''
    const counts = new Map<string, number>()
    const timers = new Map<string, number>()

    const print = (stream: WritableLike, text: string): void => {
      const lines = indent === '' ? text : indent + text.replace(/\n/g, `\n${indent}`)
      try {
        stream.write(`${lines}\n`, () => {})
      } catch (error) {
        if (!ignoreErrors) throw error
      }
    }
    const out = (...args: unknown[]): void => { print(stdout, format(...args)) }
    const err = (...args: unknown[]): void => { print(stderr, format(...args)) }
    const labelOf = (label: unknown): string => label === undefined ? 'default' : String(label)

    this.log = out
    this.info = out
    this.debug = out
    this.dirxml = out
    this.warn = err
    this.error = err
    this.trace = (...args) => {
      const trace = Object.assign(new Error(format(...args)), { name: 'Trace' })
      const frames = (trace.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).slice(1)
      print(stderr, [`Trace${trace.message === '' ? '' : `: ${trace.message}`}`, ...frames].join('\n'))
    }
    this.dir = (value, dirOptions) => { print(stdout, inspect(value, { customInspect: false, ...inspectOptions, ...dirOptions } as never)) }
    this.table = (data, properties) => {
      if (properties !== undefined && !Array.isArray(properties)) {
        throw Object.assign(new TypeError(`The "properties" argument must be an instance of Array. Received ${typeof properties}`), { code: 'ERR_INVALID_ARG_TYPE' })
      }
      const grid = renderTable(data, properties)
      if (grid === undefined) out(data)
      else out(grid)
    }
    this.assert = (condition, ...args) => {
      if (condition) return
      const [first, ...rest] = args
      err(...(typeof first === 'string' ? [`Assertion failed: ${first}`, ...rest] : ['Assertion failed', ...args]))
    }
    this.count = (label) => {
      const key = labelOf(label)
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      out(`${key}: ${next}`)
    }
    this.countReset = (label) => {
      const key = labelOf(label)
      if (counts.delete(key)) return
      warn(`Count for '${key}' does not exist`)
    }
    this.group = (...labels) => {
      if (labels.length > 0) out(...labels)
      indent += groupStep
    }
    this.groupCollapsed = this.group
    this.groupEnd = () => { indent = indent.slice(0, Math.max(0, indent.length - groupStep.length)) }
    this.time = (label) => {
      const key = labelOf(label)
      if (timers.has(key)) { warn(`Label '${key}' already exists for console.time()`); return }
      timers.set(key, performance.now())
    }
    const elapsed = (name: string, key: string): number | undefined => {
      const started = timers.get(key)
      if (started === undefined) { warn(`No such label '${key}' for console.${name}()`); return undefined }
      return performance.now() - started
    }
    this.timeEnd = (label) => {
      const key = labelOf(label)
      const took = elapsed('timeEnd', key)
      if (took === undefined) return
      timers.delete(key)
      out(`${key}: ${formatTime(took)}`)
    }
    this.timeLog = (label, ...data) => {
      const key = labelOf(label)
      const took = elapsed('timeLog', key)
      if (took !== undefined) out(`${key}: ${formatTime(took)}`, ...data)
    }
  }
}
