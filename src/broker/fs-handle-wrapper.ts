// Wraps a real `OpenedFile` (./fs-contracts.js) into the app-facing
// `FailableFileHandle`, under the per-origin in-flight budget and the fs
// write quota -- split out of ./fs-capability.ts so `orivon.fs.open` AND
// `orivon.fs.userSelected`'s picked files share exactly ONE implementation
// of this (code-guidelines.md Rule 3), rather than each acquiring the same
// quota-refund and in-flight-scoping logic a second time. A picked file's
// bytes count against the SAME per-origin quota `fs.open`'s do -- writing
// through a user-granted folder is not a way around a declared storage
// limit.

import { fail } from './errors.js'
import { mapIoError } from './io-errors.js'
import type { HandleTable } from './handles/handles.js'
import type { FailableFileHandle, HandleEntry } from './handles/handle-contracts.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import type { OpenedFile } from './fs-contracts.js'

/**
 * Every flags string `node:fs`'s own `open` accepts (its docs' "File system
 * flags" table) plus the two numeric-mode variants are out of scope --
 * `capability-api.ts`'s `open` takes a `string`, never a number. Shared by
 * `orivon.fs.open` and `orivon.fs.userSelected`'s own nested `open` (Rule
 * 3) so the two can never drift into checking a different set. Checked
 * BEFORE the confined path or the grant/pick ever matter, so a malformed
 * flags string is 'invalid' (an app bug) rather than surfacing as whatever
 * the raw adapter call happens to throw for it -- which would be
 * 'internal', the code reserved for a BROKER fault (errors.ts).
 */
export const VALID_OPEN_FLAGS: ReadonlySet<string> = new Set([
  'r', 'r+', 'rs', 'rs+', 'w', 'wx', 'w+', 'wx+', 'a', 'ax', 'a+', 'ax+'
])

export interface FileHandleWrapperOptions {
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
}

export interface FileHandleWrapper {
  /** Wraps an already-registered handle entry into the app-facing `FailableFileHandle`. */
  toFailableFileHandle: (key: string, entry: HandleEntry, fields: Omit<OpenedFile, 'destroy'>) => FailableFileHandle
}

/** One instance per broker (`../index.ts` constructs it once, alongside `HandleTable`/`GrantLedger` themselves), shared by ./fs-capability.ts and ./user-selected-capability.ts. */
export function createFileHandleWrapper ({ handleTable, ledger }: FileHandleWrapperOptions): FileHandleWrapper {
  /** `net-capability.ts`'s `runIo`-under-`{on:'handle'}` shape, applied here: re-checks ownership (T11c) and is cancelled the instant `closeTree` reaches this handle. */
  async function runFileIo<T> (key: string, handleId: string, io: () => Promise<T>): Promise<T> {
    return await handleTable.run(key, { on: 'handle', handleId }, async (signal) => {
      if (signal.aborted) throw fail('revoked', 'the grant authorising this fs operation was withdrawn')
      let result: T
      try {
        result = await io()
      } catch (error) {
        throw mapIoError(error, 'fs')
      }
      if (signal.aborted) throw fail('revoked', 'the grant authorising this fs operation was withdrawn')
      return result
    })
  }

  /**
   * Errors the stream on the chunk that exceeds quota, unlike `udp.send`'s
   * counted, never-rejecting loss (A87) -- `fs-capability.ts`'s own doc on
   * `quotaCheckedWritable` explains why a silent drop is wrong for a file
   * write specifically. One running `reserveFsBytes`/`releaseFsBytes`
   * counter per origin, shared with positional `write()` below and with
   * `fs.open`'s own writable() -- neither path can be used to exceed what
   * the other already enforces.
   */
  function quotaCheckedWritable (key: string, real: WritableStream<Uint8Array>): WritableStream<Uint8Array> {
    const writer = real.getWriter()
    return new WritableStream<Uint8Array>({
      async write (chunk) {
        if (!ledger.reserveFsBytes(key, chunk.byteLength)) {
          throw fail('limit', "this write would exceed the app's declared storage quota")
        }
        try {
          await writer.write(chunk)
        } catch (error) {
          ledger.releaseFsBytes(key, chunk.byteLength)
          throw error
        }
      },
      async close () { await writer.close() },
      async abort (reason) { await writer.abort(reason) }
    })
  }

  /**
   * Runs truncate() calls against the SAME handle strictly one at a time.
   * `truncate`'s own doc explains why: computing the growth charge needs a
   * "current size" read that is still true the instant the real truncate
   * runs. `handleTable.run` (T11b) never serialises concurrent calls
   * against one handle, so two truncates issued back to back could both
   * read the pre-truncate size and race the reservation against it -- this
   * queue is what actually closes that window, by keeping only one
   * stat-then-truncate sequence in flight per handle id at a time.
   *
   * Keyed by handle id alone, not (origin, id) -- ids are drawn from
   * `handles.ts`'s global, unguessable pool and never reused while a
   * `recentlyClosed` entry for one still exists, so two live handles never
   * collide on this key. `advance` is an ordering-only tail that never
   * rejects (so the next caller's `?? Promise.resolve()` fallback never
   * adopts a rejected chain); `run` is what the caller actually awaits and
   * rejects exactly as `work()` would on its own. The map entry is dropped
   * once nothing is queued behind it, so this never grows across a session.
   *
   * Shared here (not per-call-site) so `fs.open` and `fs.userSelected`'s
   * picked files serialise against the SAME map -- one handle id can only
   * ever belong to one of the two callers, so no cross-talk, but a single
   * lock keeps the invariant obviously true rather than merely accidental.
   */
  const truncateChains = new Map<string, Promise<void>>()
  function withTruncateLock<T> (handleId: string, work: () => Promise<T>): Promise<T> {
    const previous = truncateChains.get(handleId) ?? Promise.resolve()
    const run = previous.then(work)
    const advance = run.then(() => {}, () => {})
    truncateChains.set(handleId, advance)
    advance.then(() => {
      if (truncateChains.get(handleId) === advance) truncateChains.delete(handleId)
    }).catch(() => {})
    return run
  }

  function toFailableFileHandle (key: string, entry: HandleEntry, fields: Omit<OpenedFile, 'destroy'>): FailableFileHandle {
    return {
      id: entry.id,
      closed: entry.closed,
      close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
      fail: (code, platformCode) => { handleTable.fail(key, entry.id, code, platformCode) },
      onUnlink: (listener) => { handleTable.onUnlink(key, entry.id, listener) },
      read: async (opts) => await runFileIo(key, entry.id, async () => await fields.read(opts)),
      write: async (opts) => {
        if (!ledger.reserveFsBytes(key, opts.data.length)) {
          throw fail('limit', "this write would exceed the app's declared storage quota")
        }
        let started = false
        try {
          return await runFileIo(key, entry.id, async () => {
            started = true
            try {
              return await fields.write(opts)
            } catch (error) {
              ledger.releaseFsBytes(key, opts.data.length) // nothing landed -- unmapped, runFileIo maps it below
              throw error
            }
          })
        } catch (error) {
          if (!started) ledger.releaseFsBytes(key, opts.data.length)
          throw error
        }
      },
      readable: (opts) => fields.readable(opts),
      writable: (opts) => quotaCheckedWritable(key, fields.writable(opts)),
      stat: async () => await runFileIo(key, entry.id, async () => await fields.stat()),
      /**
       * Node's `truncate` EXTENDS a file with null bytes when `length`
       * exceeds its current size -- so growing past the current size is a
       * write in every sense the quota cares about (manifest.ts's
       * `quotaBytes` doc, and `write`'s own comment above), and must be
       * charged and refusable exactly like one. Shrinking releases the
       * difference instead, or the counter would drift upward forever on
       * an app that writes little but truncates often; a same-length
       * truncate touches the ledger at all.
       *
       * `currentSize` is read fresh, under `withTruncateLock`, immediately
       * before this same call's own real truncate -- seeing this file's
       * OWN previous truncate land, never a stale read raced by another one
       * (see that lock's own doc). A concurrent `write()` to the same
       * handle can still move the real size in between; that race is
       * `write()`'s own pre-existing quota model (which charges every byte
       * written, not the file's resulting size) and is not newly opened or
       * closed by this fix.
       */
      truncate: async (length) => await withTruncateLock(entry.id, async () => {
        const { size: currentSize } = await runFileIo(key, entry.id, async () => await fields.stat())
        const delta = length - currentSize
        if (delta <= 0) {
          await runFileIo(key, entry.id, async () => { await fields.truncate(length) })
          if (delta < 0) ledger.releaseFsBytes(key, -delta)
          return
        }
        if (!ledger.reserveFsBytes(key, delta)) {
          throw fail('limit', "this truncate would exceed the app's declared storage quota")
        }
        let started = false
        try {
          await runFileIo(key, entry.id, async () => {
            started = true
            try {
              await fields.truncate(length)
            } catch (error) {
              ledger.releaseFsBytes(key, delta) // nothing landed -- unmapped, runFileIo maps it below
              throw error
            }
          })
        } catch (error) {
          // Same "refund only what never reached the raw call" rule as write's own catch above.
          if (!started) ledger.releaseFsBytes(key, delta)
          throw error
        }
      }),
      sync: async () => await runFileIo(key, entry.id, async () => { await fields.sync() })
    }
  }

  return { toFailableFileHandle }
}
