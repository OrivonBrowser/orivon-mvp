// `execFile` and `exec` over `spawn`: output buffered up to `maxBuffer`, the
// callback given Node's error shape, and a promise form through
// util.promisify, as Node's own carry.

import { Buffer } from 'buffer'
import { codedError } from '../node-errors.js'
import type { ChildProcess } from './child.js'
import { splitCommand } from './command-line.js'
import { type SpawnOptions, spawn } from './spawn.js'

export interface ExecOptions extends SpawnOptions {
  readonly encoding?: BufferEncoding | 'buffer' | null
  readonly maxBuffer?: number
}

type Output = string | Buffer
export type ExecCallback = (error: ExecError | null, stdout: Output, stderr: Output) => void

export interface ExecError extends Error {
  code?: number | string | null
  killed?: boolean
  signal?: string | null
  cmd?: string
  stdout?: Output
  stderr?: Output
}

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')
const DEFAULT_MAX_BUFFER = 1024 * 1024

function parseArguments (rest: unknown[]): { args: string[], options: ExecOptions, callback: ExecCallback | undefined } {
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() as ExecCallback : undefined
  // `args` may be an array, or undefined or null standing in for one before `options`.
  const leading = rest[0]
  const args = Array.isArray(leading) || leading === undefined || leading === null ? ((rest.shift() as unknown[] | null | undefined) ?? []).map(String) : []
  const options = (rest[0] ?? {}) as ExecOptions
  return { args, options, callback }
}

function collect (child: ChildProcess, options: ExecOptions, command: string, callback: ExecCallback | undefined): void {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  const size = { stdout: 0, stderr: 0 }
  let failure: ExecError | undefined
  let done = false
  const decode = (buffers: Buffer[]): Output => {
    const joined = Buffer.concat(buffers)
    return options.encoding === 'buffer' || options.encoding === null ? joined : joined.toString(options.encoding ?? 'utf8')
  }
  const finish = (error: ExecError | null): void => {
    if (done) return
    done = true
    const stdout = decode(chunks.stdout)
    const stderr = decode(chunks.stderr)
    callback?.(error === null ? null : Object.assign(error, { stdout, stderr }), stdout, stderr)
  }
  for (const name of ['stdout', 'stderr'] as const) {
    child[name]?.on('data', (chunk: Buffer) => {
      size[name] += chunk.length
      if (size[name] > maxBuffer) {
        failure ??= codedError(RangeError, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', `${name} maxBuffer length exceeded`)
        child.kill(options.killSignal ?? 'SIGTERM')
        return
      }
      chunks[name].push(chunk)
    })
  }
  child.once('error', (error: ExecError) => { finish(error) })
  child.once('close', (code: number | null, signal: string | null) => {
    if (failure !== undefined) { finish(failure); return }
    if (code === 0 && signal === null) { finish(null); return }
    const stderr = decode(chunks.stderr).toString()
    finish(Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { code, killed: child.killed, signal, cmd: command }))
  })
}

function promiseForm (run: (callback: ExecCallback) => ChildProcess): Promise<{ stdout: Output, stderr: Output }> & { child: ChildProcess } {
  let child: ChildProcess | undefined
  const promise = new Promise<{ stdout: Output, stderr: Output }>((resolve, reject) => {
    child = run((error, stdout, stderr) => { if (error === null) resolve({ stdout, stderr }); else reject(error) })
  })
  return Object.assign(promise, { child: child as ChildProcess })
}

export function execFile (file: string, callback?: ExecCallback): ChildProcess
export function execFile (file: string, args: readonly string[] | undefined, callback?: ExecCallback): ChildProcess
export function execFile (file: string, options: ExecOptions, callback?: ExecCallback): ChildProcess
export function execFile (file: string, args: readonly string[] | undefined, options: ExecOptions | undefined, callback?: ExecCallback): ChildProcess
export function execFile (file: string, ...rest: unknown[]): ChildProcess {
  const { args, options, callback } = parseArguments(rest)
  const child = spawn(file, args, { ...options, stdio: 'pipe' })
  collect(child, options, [file, ...args].join(' '), callback)
  return child
}

export function exec (command: string, callback?: ExecCallback): ChildProcess
export function exec (command: string, options: ExecOptions | undefined, callback?: ExecCallback): ChildProcess
export function exec (command: string, ...rest: unknown[]): ChildProcess {
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() as ExecCallback : undefined
  const options = (rest[0] ?? {}) as ExecOptions
  const [file, ...args] = splitCommand(command)
  if (file === undefined) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'command' cannot be empty. Received ''")
  const child = spawn(file, args, { ...options, shell: false, stdio: 'pipe' })
  collect(child, options, command, callback)
  return child
}

type Variadic = (first: string, ...rest: unknown[]) => ChildProcess

// util.promisify reads this symbol; a plain assignment, as Node's own is replaceable.
;(execFile as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM] = (file: string, ...rest: unknown[]) =>
  promiseForm((callback) => (execFile as Variadic)(file, ...rest, callback))
;(exec as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM] = (command: string, ...rest: unknown[]) =>
  promiseForm((callback) => (exec as Variadic)(command, ...rest, callback))
