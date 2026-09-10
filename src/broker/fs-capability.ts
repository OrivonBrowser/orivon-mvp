// orivon.fs's entry points -- readFile, writeFile, confineSync (ADR-0016),
// plus the extended set added for queue item 2.1: mkdir, readdir, stat, rm,
// rename. Lifted out of ./index.ts under the same Rule 2 seam
// net-capability.ts and id-capability.ts already established --
// README.md's own design notes name this as the next seam once fs's entry
// points grew past what one flat call justified. `FileHandle`
// (orivon.fs.open) is NOT here -- see this lane's own PR body for why it
// was parked rather than built alongside these five.
//
// SAME DEPENDENCY SHAPE AS ./index.ts ITSELF -- the HandleTable and
// GrantLedger it already built, plus `canonical`, are passed in rather than
// redefined here. A pure move for readFile/writeFile/confineSync: every
// test that exercised them through createBroker keeps exercising the exact
// same functions, just imported from here instead of defined inline.
//
// CONFINEMENT IS PROVEN PER CALL, NOT ONCE, and that is this file's whole
// reason to exist as a single seam: every one of the eight methods below --
// including BOTH sides of rename -- routes through `confineForOrigin`, the
// ONE call into policy/paths.ts's confinePath (code-guidelines.md Rule 3).
// A second confinement implementation, anywhere, is the bug this file
// exists to make impossible.

import { fail } from './errors.js'
import { mapIoError } from './io-errors.js'
import { CONFINEMENT_ERROR_CODE, confinePath } from './policy/paths.js'
import type { HandleTable } from './handles/handles.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import type { Broker, CreateBrokerOptions, RawFileStat } from './broker-contracts.js'
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
   * `net.connect` uses (`{ on: 'grant' }` -- handle-contracts.ts on that
   * scope: "without it those calls would escape the in-flight cap entirely,
   * which is the cap that keeps the broker responsive", T11b). Before
   * readFile/writeFile were routed through this, `fs` called `deps.fs.*`
   * directly and was subject to no cap at all -- every method added since
   * shares this same fix rather than reopening the gap for itself.
   *
   * `signal.aborted` is checked on both sides of the raw call: before, in
   * case the grant was already gone by the time a slot freed up; after,
   * because revoking mid-call must not let the app receive confirmation for
   * an operation performed after its grant was withdrawn.
   */
  async function runFsIo<T> (key: string, grant: Grant, io: () => Promise<T>): Promise<T> {
    return await handleTable.run(key, { on: 'grant', grantId: grant.id }, async (signal) => {
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

  return { readFile, writeFile, confineSync, mkdir, readdir, stat, rm, rename }
}
