// The Worker synchronous twin's `fs` surface (Symbol.for('orivon.synchronous'),
// worker/orivon-client.ts) -- a leaf both fs/core-sync.ts and fs/handle.ts
// import, so neither has to import the other just to reach it (core-sync.ts
// already needs handle.ts's openHandleSync, the one-way dependency core.ts
// and handle.ts already have).
//
// ADR-0016's amendment: every path-based fs *Sync call works in a Worker (a
// forked child or a worker_threads thread) of a cross-origin isolated app,
// over this twin. Elsewhere -- the page, or a Worker with no
// SharedArrayBuffer -- `syncFs()` throws fs/unsupported.ts's own
// OrivonFsUnsupportedError.

import { SYNCHRONOUS } from '../worker/sync-channel.js'
import { getOrivon } from '../orivon-global.js'
import { OrivonFsUnsupportedError } from './unsupported.js'
import { toNodeError } from '../node-errors.js'

/** What orivon.fs.open's synchronous twin returns: a handle whose own methods block too (orivon-client.ts's `decodeSync`). */
export interface SyncFileHandleWire {
  read (opts: { position: number, length: number }): Uint8Array
  write (opts: { position: number, data: Uint8Array }): number
  stat (): { size: number, isFile: boolean, isDirectory: boolean, mtimeMs: number }
  truncate (length: number): void
  sync (): void
  close (): void
}

/** The same member names orivon.fs (async) has, called blocking instead of awaited. */
export interface SyncOrivonFs {
  stat (path: string): { size: number, isFile: boolean, isDirectory: boolean, mtimeMs: number }
  readFile (path: string): Uint8Array
  writeFile (path: string, data: Uint8Array): void
  mkdir (path: string, opts?: { recursive?: boolean }): void
  readdir (path: string): readonly string[]
  rm (path: string, opts?: { recursive?: boolean }): void
  rename (from: string, to: string): void
  open (path: string, flags: string): SyncFileHandleWire
}

/** `undefined` outside a Worker with shared memory -- never throws, for existsSync's own fallback to the page's whole-file-read route. */
function trySyncFs (): SyncOrivonFs | undefined {
  return (getOrivon() as unknown as Record<symbol, { fs: SyncOrivonFs } | undefined>)[SYNCHRONOUS]?.fs
}

/** Every *Sync export calls this first: the one place that decides whether it can run here at all. */
export function syncFs (api: string): SyncOrivonFs {
  const fs = trySyncFs()
  if (fs === undefined) {
    throw new OrivonFsUnsupportedError(
      api,
      'this call works in a forked child or a worker_threads.Worker of a cross-origin isolated app, ' +
      'over the synchronous channel -- not on the page, and not in a Worker with no SharedArrayBuffer. Use the async form here',
      'ERR_ORIVON_FS_SYNC_UNSUPPORTED'
    )
  }
  return fs
}

/**
 * A rate-limited call was refused before it ran, so asking again is safe, and a synchronous caller has no
 * way to wait and ask again itself: a burst of calls (a program starting up) would otherwise fail the
 * first call past the origin's bucket.
 */
const LIMIT_RETRIES = 40
const LIMIT_BACKOFF_MS = 25

function isLimit (error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'limit'
}

function sleepSync (ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Runs one orivon.fs call, rethrowing its OrivonError as a Node-shaped one -- fs/paths.ts's guarded(), synchronous. */
export function guardedSync<T> (run: () => T, sleep: (ms: number) => void = sleepSync): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run()
    } catch (error) {
      if (attempt < LIMIT_RETRIES && isLimit(error)) {
        sleep(LIMIT_BACKOFF_MS * Math.min(attempt + 1, 8))
        continue
      }
      throw toNodeError(error)
    }
  }
}

/** existsSync's own probe: true/false in a Worker, undefined so the caller can fall back to the page's whole-file read. */
export function tryStatSync (confined: string): boolean | undefined {
  const fs = trySyncFs()
  if (fs === undefined) return undefined
  try {
    fs.stat(confined)
    return true
  } catch {
    return false
  }
}
