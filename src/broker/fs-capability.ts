// orivon.fs's entry points -- readFile, writeFile, confineSync (ADR-0016),
// the extended set added for queue item 2.1 (mkdir, readdir, stat, rm,
// rename), and `open` (FileHandle, A184). Lifted out of ./index.ts under
// the same Rule 2 seam net-capability.ts and id-capability.ts already
// established -- README.md's own design notes name this as the next seam
// once fs's entry points grew past what one flat call justified.
//
// SAME DEPENDENCY SHAPE AS ./index.ts ITSELF -- the HandleTable and
// GrantLedger it already built, plus `canonical`, are passed in rather than
// redefined here. A pure move for readFile/writeFile/confineSync: every
// test that exercised them through createBroker keeps exercising the exact
// same functions, just imported from here instead of defined inline.
//
// CONFINEMENT IS PROVEN PER CALL, NOT ONCE, and that is this file's whole
// reason to exist as a single seam: every one of the methods below --
// including BOTH sides of rename, and `open` -- routes through
// `confineForOrigin`, the ONE call into policy/paths.ts's confinePath
// (code-guidelines.md Rule 3). A second confinement implementation,
// anywhere, is the bug this file exists to make impossible. `open` confines
// exactly once, at open time -- see its own doc for why that is sufficient
// even though the handle it returns outlives this call.

import { fail } from './errors.js'
import { mapIoError } from './io-errors.js'
import { CONFINEMENT_ERROR_CODE, confinePath } from './policy/paths.js'
import type { HandleTable } from './handles/handles.js'
import type { OperationScope } from './handles/handle-contracts.js'
import type { FailableFileHandle, HandleEntry } from './handles/handle-contracts.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import type { Broker, CreateBrokerOptions, OpenedFile, RawFileStat } from './broker-contracts.js'
import type { Grant } from '../contracts/index.js'

export interface FsCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ./index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
}

/** Builds `Broker['fs']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createFsCapability ({ deps, handleTable, ledger, canonical }: FsCapabilityOptions): Broker['fs'] {
  /**
   * The `fs` capability check plus path confinement, shared by every method
   * below (Rule 3 -- these were byte-for-byte the same logic before this
   * was pulled out for readFile/writeFile, and every method added since
   * reuses it rather than growing a second copy).
   *
   * `fs` carries no patterns (manifest.ts's FsCapability), so the
   * capability check here is presence-only: does this origin hold ANY live
   * `fs` grant. Returns the `Grant` itself, not only the confined path --
   * the caller needs its id to scope the actual I/O under `handleTable.run`.
   *
   * Synchronous, and stays that way: `confinePath`'s `realpath` parameter is
   * `policy/paths.ts`'s, declared synchronous (filed as A28 -- an origin on
   * a slow filesystem can still block other origins' pending calls through
   * this exact function; making `realpath` async is the fix, not this one).
   */
  function confineForOrigin (key: string, path: string): { resolved: string, grant: Grant } {
    const grant = ledger.currentGrant(key, 'fs')
    if (grant === undefined) throw fail('denied', 'fs is not granted to this origin')
    const root = deps.fs.rootFor(key)
    const confined = confinePath(root, path, deps.fs.realpathSync)
    if (!confined.ok) throw fail(CONFINEMENT_ERROR_CODE, "the path is outside this app's files directory")
    return { resolved: confined.resolved, grant }
  }

  /**
   * Every `fs` I/O call runs under the SAME per-origin in-flight budget
   * `net.connect` uses (T11b). `signal.aborted` is checked on both sides of
   * the raw call: before, in case the grant/handle was already gone by the
   * time a slot freed up; after, because revoking mid-call must not let the
   * app receive confirmation for an operation performed after its
   * authorisation was withdrawn. Shared by `runFsIo` and `runFileIo` below
   * (Rule 3): both wrap one raw call in the identical revocation-aware,
   * error-mapped shape and differ only in what `scope` attributes it to.
   */
  async function runIo<T> (key: string, scope: OperationScope, io: () => Promise<T>): Promise<T> {
    return await handleTable.run(key, scope, async (signal) => {
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
   * Scoped to the GRANT -- the right attribution for a call with no handle
   * of its own yet (readFile/writeFile/mkdir/.../open's own acquisition).
   * Before readFile/writeFile were routed through this, `fs` called
   * `deps.fs.*` directly and was subject to no in-flight cap at all -- every
   * method added since shares this same fix rather than reopening the gap.
   */
  async function runFsIo<T> (key: string, grant: Grant, io: () => Promise<T>): Promise<T> {
    return await runIo(key, { on: 'grant', grantId: grant.id }, io)
  }

  /**
   * Scoped to the HANDLE -- for a call against an ALREADY-OPEN FileHandle
   * (`open`'s own read/write/stat/truncate/sync). `{on:'handle'}` re-checks
   * ownership of THIS handle (T11c) via `HandleTable.run`, and is cancelled
   * the instant `closeTree` reaches it -- a direct close(), a fail()/
   * abort(), or a grant revocation cascading through it -- unlike `open`'s
   * own `{on:'grant'}` scope, which only ever covers the acquisition itself.
   */
  async function runFileIo<T> (key: string, handleId: string, io: () => Promise<T>): Promise<T> {
    return await runIo(key, { on: 'handle', handleId }, io)
  }

  /**
   * ADR-0016's synchronous entry point: `orivon.fs.readFileSync` needs the
   * SAME grant check and path confinement `readFile`/`writeFile` use, over
   * `ipcRenderer.sendSync` rather than the async control channel -- see
   * `./transport/sync-fs.ts`'s own header for the caller and why it cannot
   * simply call `readFile` above instead (a synchronous IPC reply has no
   * way to await one). Reuses `confineForOrigin` itself, so a traversal or
   * symlink escape is refused by the exact same check on both paths, never
   * a second implementation of it.
   *
   * DELIBERATELY OUTSIDE `runFsIo`'s per-origin in-flight budget
   * (`handleTable.run`, above) -- that budget is `async`-shaped by
   * construction (`work: (signal) => Promise<T>`), and a synchronous IPC
   * reply cannot await a slot becoming free without turning ADR-0016's
   * "the renderer genuinely blocks" into "the renderer blocks on a queue it
   * cannot see the position of". Filed rather than fixed here -- see
   * open-questions.md.
   */
  function confineSync (origin: string, path: string): string {
    const key = canonical(origin)
    return confineForOrigin(key, path).resolved
  }

  async function readFile (origin: string, path: string): Promise<Uint8Array> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    return await runFsIo(key, grant, async () => await deps.fs.readFile(resolved))
  }

  /**
   * manifest.ts's FsCapability.quotaBytes: "ENFORCED, not advisory ... The
   * broker maintains a running per-origin byte counter, checks it on write,
   * and yields 'limit' when exceeded." `ledger.reserveFsBytes` checks AND
   * reserves in one synchronous step, before this function's first `await`
   * -- concurrent callers cannot all read the same pre-write counter and
   * all pass (see that method's own doc). Undeclared quota means unlimited.
   * `started` below distinguishes "never touched disk" (refund) from
   * "touched disk, then told 'revoked' anyway" (do not); session-lifetime
   * only, A29 tracks reconciling against disk on startup.
   */
  async function writeFile (origin: string, path: string, data: Uint8Array): Promise<void> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    if (!ledger.reserveFsBytes(key, data.length)) {
      throw fail('limit', "this write would exceed the app's declared storage quota")
    }
    let started = false
    try {
      await runFsIo(key, grant, async () => {
        started = true
        try {
          await deps.fs.writeFile(resolved, data)
        } catch (error) {
          ledger.releaseFsBytes(key, data.length) // nothing landed -- unmapped, runFsIo maps it below
          throw error
        }
      })
    } catch (error) {
      // False only when deps.fs.writeFile was never called (in-flight cap,
      // or an already-revoked grant) -- refund there too. deps.fs.writeFile
      // takes no AbortSignal, so once called it lands regardless of
      // revocation -- only the catch above may refund after that point.
      if (!started) ledger.releaseFsBytes(key, data.length)
      throw error
    }
  }

  /**
   * Reserves no quota, unlike `writeFile` -- `quotaBytes` tracks bytes
   * WRITTEN (`writeFile`'s own doc above), and an empty directory has none.
   */
  async function mkdir (origin: string, path: string, opts?: { recursive?: boolean }): Promise<void> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    await runFsIo(key, grant, async () => { await deps.fs.mkdir(resolved, opts) })
  }

  async function readdir (origin: string, path: string): Promise<readonly string[]> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    return await runFsIo(key, grant, async () => await deps.fs.readdir(resolved))
  }

  async function stat (origin: string, path: string): Promise<RawFileStat> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    return await runFsIo(key, grant, async () => await deps.fs.stat(resolved))
  }

  /**
   * Reserves no quota, for the same reason `mkdir` does not -- deleting
   * frees storage, it never consumes the write budget. `force` is never
   * exposed above `BrokerFs.rm` (see that interface's own doc): a missing
   * path surfaces `notFound`, exactly like every other fs call.
   */
  async function rm (origin: string, path: string, opts?: { recursive?: boolean }): Promise<void> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    await runFsIo(key, grant, async () => { await deps.fs.rm(resolved, opts) })
  }

  /**
   * BOTH `from` AND `to` are confined independently, through the exact same
   * `confineForOrigin` call `readFile`/`writeFile` already use -- THIS IS
   * THE WHOLE POINT of this method's shape. A confinement check on `from`
   * alone, with `to` handed to `deps.fs.rename` unchecked, would turn
   * `orivon.fs.rename` into an arbitrary-write primitive: a `to` of
   * `../../../../home/user/.bashrc` moves a file the app legitimately owns
   * to a path outside its root entirely, and nothing about `from` being
   * safe stops that. See fs-capability-extended.test.ts's "rename confines
   * the destination, not only the source" for the regression this guards
   * against.
   */
  async function rename (origin: string, from: string, to: string): Promise<void> {
    const key = canonical(origin)
    const source = confineForOrigin(key, from)
    const destination = confineForOrigin(key, to)
    await runFsIo(key, source.grant, async () => { await deps.fs.rename(source.resolved, destination.resolved) })
  }

  /**
   * Every flags string `node:fs`'s own `open` accepts (its docs' "File
   * system flags" table) plus the two numeric-mode variants are out of
   * scope -- `capability-api.ts`'s `open` takes a `string`, never a number.
   * Checked HERE, before the confined path or the grant ever matter, so a
   * malformed flags string is 'invalid' (an app bug) rather than surfacing
   * as whatever `deps.fs.open` happens to throw for it -- which would be
   * 'internal', the code reserved for a BROKER fault (errors.ts).
   */
  const VALID_OPEN_FLAGS: ReadonlySet<string> = new Set([
    'r', 'r+', 'rs', 'rs+', 'w', 'wx', 'w+', 'wx+', 'a', 'ax', 'a+', 'ax+'
  ])

  /**
   * Wraps a real writable byte stream so every chunk is checked against the
   * running per-origin storage quota before it lands -- `writable()`'s own
   * counterpart to `write()`'s `reserveFsBytes`/`releaseFsBytes` pair below.
   * `writable()` has no single request to reject wholesale the way a
   * positional `write()` call does: each chunk on the stream is its own
   * reservation, refunded if the underlying write itself then fails.
   *
   * UNLIKE `udp.send`'s counted, never-rejecting loss (A87), exceeding the
   * quota here DOES error the stream. A torrent write that silently
   * dropped bytes past quota would corrupt the file on disk where a
   * dropped datagram merely loses one packet a swarm already tolerates
   * losing -- the two are not the same shape of failure, so they do not
   * get the same treatment (code-guidelines.md Rule 3's counterweight).
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

  /** Wraps an already-registered handle entry into the app-facing `FailableFileHandle` -- `net-capability.ts`'s `toFailableSocket` is the pattern this follows. */
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
          // Same "refund only what never reached the raw call" rule as
          // writeFile's own catch above.
          if (!started) ledger.releaseFsBytes(key, opts.data.length)
          throw error
        }
      },
      readable: (opts) => fields.readable(opts),
      writable: (opts) => quotaCheckedWritable(key, fields.writable(opts)),
      stat: async () => await runFileIo(key, entry.id, async () => await fields.stat()),
      truncate: async (length) => await runFileIo(key, entry.id, async () => { await fields.truncate(length) }),
      sync: async () => await runFileIo(key, entry.id, async () => { await fields.sync() })
    }
  }

  /**
   * `orivon.fs.open` -- confines and checks the grant exactly ONCE, here,
   * the same as every method above. WHETHER THAT IS SUFFICIENT for a handle
   * that outlives this call was the open question this lane's brief named,
   * and the answer is yes: every operation against the returned handle
   * (`read`/`write`/`stat`/`truncate`/`sync`/`readable`/`writable`) goes
   * through the real OS file descriptor `deps.fs.open` returns, never
   * through the path again -- there is nothing left to re-resolve, so a
   * symlink swapped in after this call cannot retarget an already-open fd
   * the way it could a second path-based call. This mirrors `net.connect`:
   * the policy check runs once, at acquisition, and everything after runs
   * against the handle, re-checking only OWNERSHIP (T11c) via `runFileIo`'s
   * `{on:'handle'}` scope -- never the grant a second time.
   *
   * Acquisition itself follows `connect`'s own shape exactly (README.md's
   * design notes on `net-capability.ts`): check `signal.aborted` before the
   * raw open, dial it, check again after in case the grant was withdrawn
   * while it was in flight, and destroy a just-opened-but-now-unwanted file
   * with 'revoked' rather than let `acquire`'s own silent 'failed' cleanup
   * paper over a real, live descriptor.
   */
  async function open (origin: string, path: string, flags: string): Promise<FailableFileHandle> {
    if (!VALID_OPEN_FLAGS.has(flags)) throw fail('invalid', `unrecognised fs.open flags: ${flags}`)
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)

    return await handleTable.run(key, { on: 'grant', grantId: grant.id }, async (signal) => {
      if (signal.aborted) throw fail('revoked', 'the grant authorising this fs operation was withdrawn')
      let opened: OpenedFile
      try {
        opened = await deps.fs.open(resolved, flags)
      } catch (error) {
        throw mapIoError(error, 'fs')
      }
      if (signal.aborted) {
        await opened.destroy('revoked')
        throw fail('revoked', 'the grant authorising this fs operation was withdrawn')
      }

      const { destroy, ...fields } = opened
      const entry = handleTable.acquire({
        origin: key,
        kind: 'file',
        authorisedBy: { by: 'grant', grantId: grant.id },
        destroy
      })

      return toFailableFileHandle(key, entry, fields)
    })
  }

  return { readFile, writeFile, confineSync, mkdir, readdir, stat, rm, rename, open }
}
