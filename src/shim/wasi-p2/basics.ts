// wasi:clocks, wasi:random and wasi:cli: the interfaces that touch no file
// and no socket.

import { delay, monotonicNs, randomBytes, realtimeNs } from '../wasi/time.js'
import { InputStream, OutputStream, Pollable } from './io.js'

/** Ready once the monotonic clock reaches `deadlineNs`; one timer however often it is polled. */
function timer (deadlineNs: bigint): Pollable {
  let fired: Promise<void> | undefined
  const remainingMs = (): number => Number(deadlineNs - monotonicNs()) / 1_000_000
  return new Pollable(() => remainingMs() <= 0, async () => {
    fired ??= delay(Math.max(remainingMs(), 0))
    await fired
  })
}

export const monotonicClock = {
  now: monotonicNs,
  resolution: (): bigint => 1_000n,
  subscribeInstant: (when: bigint): Pollable => timer(when),
  subscribeDuration: (duration: bigint): Pollable => timer(monotonicNs() + duration)
}

export const wallClock = {
  now: (): { seconds: bigint, nanoseconds: number } => {
    const ns = realtimeNs()
    return { seconds: ns / 1_000_000_000n, nanoseconds: Number(ns % 1_000_000_000n) }
  },
  resolution: (): { seconds: bigint, nanoseconds: number } => ({ seconds: 0n, nanoseconds: 1_000 })
}

function getRandomBytes (len: bigint): Uint8Array {
  return randomBytes(Number(len))
}

function randomU64 (): bigint {
  return new DataView(randomBytes(8).buffer).getBigUint64(0)
}

export const random = { getRandomBytes, getRandomU64: randomU64 }
export const insecure = { getInsecureRandomBytes: getRandomBytes, getInsecureRandomU64: randomU64 }
export const insecureSeed = { insecureSeed: (): [bigint, bigint] => [randomU64(), randomU64()] }

/** How wasi:cli/exit unwinds the component: an Error, so the glue rethrows it rather than lowering it. */
export class ComponentExit extends Error {
  readonly code: number

  constructor (code: number) {
    super(`component exited with code ${code}`)
    this.name = 'ComponentExit'
    this.code = code
  }
}

export const exit = {
  exit: (status: { tag: 'ok' | 'err' }): never => { throw new ComponentExit(status.tag === 'ok' ? 0 : 1) },
  exitWithCode: (code: number): never => { throw new ComponentExit(code) }
}

export interface CliOptions {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly stdin: InputStream
  readonly stdout: OutputStream
  readonly stderr: OutputStream
}

/** A program here has no terminal: every terminal query answers none. */
export class TerminalInput {}
export class TerminalOutput {}

export function cliInterfaces (options: CliOptions): Record<string, Record<string, unknown>> {
  return {
    'wasi:cli/environment': {
      getEnvironment: (): Array<[string, string]> => Object.entries(options.env),
      getArguments: (): string[] => [...options.args],
      initialCwd: (): string | undefined => options.cwd
    },
    'wasi:cli/exit': exit,
    'wasi:cli/stdin': { getStdin: (): InputStream => options.stdin },
    'wasi:cli/stdout': { getStdout: (): OutputStream => options.stdout },
    'wasi:cli/stderr': { getStderr: (): OutputStream => options.stderr },
    'wasi:cli/terminal-input': { TerminalInput },
    'wasi:cli/terminal-output': { TerminalOutput },
    'wasi:cli/terminal-stdin': { getTerminalStdin: (): undefined => undefined },
    'wasi:cli/terminal-stdout': { getTerminalStdout: (): undefined => undefined },
    'wasi:cli/terminal-stderr': { getTerminalStderr: (): undefined => undefined }
  }
}
