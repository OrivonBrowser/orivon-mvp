// What an import function asks its driver for, instead of awaiting it: an
// orivon.fs call, a call on an open file, stdin, output, a pause, or several
// of these at once. Each
// function is written once, as a generator of these, and runs under either
// driver (drivers.ts): the asynchronous one awaits them, the synchronous one
// answers them at once, for a module that cannot suspend.

import type { FileStat } from '../../contracts/handles.js'

export type FsMethod = 'open' | 'stat' | 'readdir' | 'mkdir' | 'rm' | 'rename'
export type HandleMethod = 'read' | 'write' | 'stat' | 'truncate' | 'sync' | 'close'

export type Effect =
  | { readonly kind: 'fs', readonly method: FsMethod, readonly args: readonly unknown[] }
  | { readonly kind: 'handle', readonly handle: unknown, readonly method: HandleMethod, readonly args: readonly unknown[] }
  | { readonly kind: 'stdin', readonly max: number }
  | { readonly kind: 'output', readonly stream: 'stdout' | 'stderr', readonly data: Uint8Array }
  | { readonly kind: 'sleep', readonly ms: number }
  | { readonly kind: 'all', readonly ops: ReadonlyArray<Op<unknown>> }

export type Op<T> = Generator<Effect, T, unknown>

/**
 * In-flight and rate limits clear on their own; a program has no code path for EAGAIN on a file. The origin's
 * call bucket refills at 100 a second, so a program that starts beside another one that is opening many
 * files and sockets can wait for seconds: the delays total about 5 s, then the limit surfaces as the
 * program's own EMFILE.
 */
const LIMIT_RETRY_DELAYS_MS = [5, 20, 80, 200, 400, 800, 1000, 1000, 1000, 1000] as const

function isBareLimit (error: unknown): boolean {
  const { code, platformCode } = typeof error === 'object' && error !== null ? error as { code?: unknown, platformCode?: unknown } : {}
  return code === 'limit' && platformCode === undefined
}

/** One file call, retried while the broker reports a bare limit. */
function * retried<T> (effect: Effect): Op<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (yield effect) as T
    } catch (error) {
      const delay = LIMIT_RETRY_DELAYS_MS[attempt]
      if (!isBareLimit(error) || delay === undefined) throw error
      yield * sleep(delay)
    }
  }
}

export function * fsCall<T> (method: FsMethod, ...args: unknown[]): Op<T> {
  return yield * retried<T>({ kind: 'fs', method, args })
}

export function * handleCall<T> (handle: unknown, method: HandleMethod, ...args: unknown[]): Op<T> {
  return yield * retried<T>({ kind: 'handle', handle, method, args })
}

export function * readStdin (max: number): Op<Uint8Array> {
  return (yield { kind: 'stdin', max }) as Uint8Array
}

export function * writeOutput (stream: 'stdout' | 'stderr', data: Uint8Array): Op<void> {
  yield { kind: 'output', stream, data }
}

export function * sleep (ms: number): Op<void> {
  yield { kind: 'sleep', ms }
}

/** Runs `ops` concurrently under the asynchronous driver, in turn under the synchronous one. */
export function * all<T> (ops: Array<Op<T>>): Op<T[]> {
  return (yield { kind: 'all', ops }) as T[]
}

/** The synchronous twin of WasiFs, for the synchronous driver: a Worker's bridge to the page, or a test's disk. */
export interface SyncFileHandle {
  read (opts: { position: number, length: number }): Uint8Array
  write (opts: { position: number, data: Uint8Array }): number
  stat (): FileStat
  truncate (length: number): void
  sync (): void
  close (): void
}

export interface SyncWasiFs {
  open (path: string, flags: string): SyncFileHandle
  stat (path: string): FileStat
  readdir (path: string): readonly string[]
  mkdir (path: string, opts?: { recursive?: boolean }): void
  rm (path: string, opts?: { recursive?: boolean }): void
  rename (from: string, to: string): void
}
