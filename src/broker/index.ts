// The capability broker. Everything under ./policy/ is a decision function;
// this file is what MAKES the decisions and HOLDS the state -- the piece
// build-plan.md's "Week 0 -- the gate" section calls the day-1 structural
// decision. GrantLedger (the per-origin state -- manifest and grants, kept
// apart on purpose) lives in ./grants/grant-ledger.ts; this file keeps the
// dependency shape and the five capability entry points that consult it.
//
// `createBroker({ dial, resolve, now, fs, keychain })` -- EXACTLY that shape.
// It is fixed on purpose (build-plan.md, policy/README.md): every capability
// test then runs against stubs, with no Electron and no network, which is
// what makes the six security-critical unit tests in
// docs/development/testing.md cheap enough to actually exist. Do not widen
// it -- a dependency this function reaches for itself is a dependency no
// stub can intercept.
//
// NO ELECTRON, NO IPC, NO MessagePortMain -- this file is constructible and
// fully testable in a plain Node test with stub dependencies. The real IPC
// wiring is ./transport/ipc.ts; if this file ever needs `electron`, it has
// crossed into that layer's job.
//
// THE FIRST JOB: hold the grant ledger per origin and consult IT, never the
// manifest, when checking a capability -- open-questions.md A18 decided the
// narrowing from "declared" to "granted" has to happen somewhere, and this
// is the only layer with both the manifest and the grant ledger in hand.
// See README.md's Design notes for this file's split history and the next seam.

import { HandleTable } from './handles/handles.js'
import { errnoOf, fail } from './errors.js'
import { mapIoError } from './io-errors.js'
import { GrantLedger } from './grants/grant-ledger.js'
import { CONFINEMENT_ERROR_CODE, confinePath } from './policy/paths.js'
import { originFromUrl } from './policy/origin.js'
import { createNetCapability } from './net-capability.js'
import { createIdCapability } from './id-capability.js'
import type {
  CapabilityKind,
  Grant,
  GrantId,
  Manifest,
  Pattern
} from '../contracts/index.js'
import type { Broker, CreateBrokerOptions } from './broker-contracts.js'

export function createBroker (deps: CreateBrokerOptions): Broker {
  const handleTable = new HandleTable()
  const ledger = new GrantLedger(deps.ledgerStorage)

  /**
   * The isolation key, through the one definition of it (policy/origin.ts) --
   * mirrors HandleTable's own private `#key()` exactly, because this
   * ledger's map is a SEPARATE table keyed on the same string and has to
   * agree with it. `https://app.example:443` and `https://app.example` must
   * land on one grant record, not two with half the capabilities each.
   *
   * Reported as 'internal', matching errors.ts: this is a broker fault --
   * every caller is expected to have already derived a real origin via
   * `originFromSenderFrame` (T3) before reaching here -- never an app-visible
   * denial.
   */
  function canonical (origin: string): string {
    const key = originFromUrl(origin)
    if (key === null) throw fail('internal', 'broker method called with a string that is not an origin')
    return key
  }

  /**
   * The `fs` capability check plus path confinement, shared by readFile and
   * writeFile (Rule 3 -- the two were byte-for-byte the same logic before
   * this was pulled out).
   *
   * `fs` carries no patterns (manifest.ts's FsCapability), so the capability
   * check here is presence-only: does this origin hold ANY live `fs` grant.
   * Returns the `Grant` itself, not only the confined path -- the caller
   * needs its id to scope the actual I/O under `handleTable.run`, the same
   * way `connect` already scopes under `current.id`.
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

  // orivon.net's three entry points. Lifted to ./net-capability.ts once
  // `listen` pushed this file past Rule 2's 500 lines -- see that file's own
  // header, and README.md's design notes, for why the split lands here.
  const net = createNetCapability({ deps, handleTable, ledger, canonical })

  // orivon.id's two entry points (publicKey, sign) -- built alongside
  // net-capability.ts from the start rather than inlined here first, for
  // the same Rule 2 reason: this file was already 264 lines before `id`.
  const id = createIdCapability({ deps, ledger, canonical })

  /**
   * `fs.readFile` and `fs.writeFile` share this shape: confine the path (see
   * `confineForOrigin`), then run the actual I/O under the same per-origin
   * in-flight budget `connect` uses (`{ on: 'grant' }` -- handle-contracts.ts
   * on that scope: "without it those calls would escape the in-flight cap
   * entirely, which is the cap that keeps the broker responsive"). Before
   * this, `fs` called `deps.fs.*` directly and was subject to no cap at all
   * -- T11b by name, and a second, distinct T11b path through the confined
   * path leaving no room for cancellation either.
   *
   * `signal.aborted` is checked on both sides of the raw call: before, in
   * case the grant was already gone by the time a slot freed up; after,
   * because revoking mid-write must not let the app receive confirmation for
   * an operation performed after its grant was withdrawn -- the write can
   * already be on disk by then, but the app is never told it succeeded.
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
   * `../transport/sync-fs.ts`'s own header for the caller and why it cannot
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

  async function manifest (origin: string): Promise<Manifest> {
    const found = ledger.manifestFor(canonical(origin))
    // A broker fault, not a denial: every real caller registers a manifest
    // before wiring an origin's IPC at all (see Broker.registerApp's doc).
    // An app asking its own broker "what is my manifest" and getting nothing
    // back means something upstream never registered it.
    if (found === undefined) throw fail('internal', 'no manifest registered for this origin')
    return found
  }

  async function grants (origin: string): Promise<readonly Grant[]> {
    return ledger.grantsFor(canonical(origin))
  }

  /**
   * Re-throws the version-floor write failure (the one thing
   * `GrantLedger.registerApp` throws) rather than swallowing it, but as an
   * OrivonError: `canonical` above already rejects with one, and one method
   * must not reject with two shapes. NOT `mapIoError` -- the floor already
   * rose in memory, so 'denied'/'limit' would misreport a broker fault as
   * the registration being refused. Fresh message, errno kept as
   * `platformCode`, for `mapIoError`'s own path-leak reason.
   */
  async function registerApp (origin: string, appManifest: Manifest): Promise<void> {
    const key = canonical(origin)
    try {
      ledger.registerApp(key, appManifest)
    } catch (error) {
      throw fail('internal', 'the version floor could not be persisted', undefined, errnoOf(error))
    }
  }

  async function versionFloorFor (origin: string): Promise<string> {
    return ledger.versionFloorFor(canonical(origin))
  }

  async function rollbackAcknowledgedVersionFor (origin: string): Promise<string | undefined> {
    return ledger.rollbackAcknowledgedVersionFor(canonical(origin))
  }

  /**
   * Same shape as `registerApp`'s own rethrow above, and for the same
   * reason: `canonical` already rejects with an OrivonError, so this method
   * must not reject with a second, raw shape when `GrantLedger.
   * acknowledgeRollback`'s write fails. The version has already been raised
   * in memory by the time this can throw -- see that method's own doc -- so
   * 'internal' reports a broker fault, never a denial of the acknowledgement
   * itself.
   */
  async function acknowledgeRollback (origin: string, version: string): Promise<void> {
    const key = canonical(origin)
    try {
      ledger.acknowledgeRollback(key, version)
    } catch (error) {
      throw fail('internal', 'the rollback acknowledgement could not be persisted', undefined, errnoOf(error))
    }
  }

  async function grant (origin: string, capability: CapabilityKind, patterns: readonly Pattern[]): Promise<Grant> {
    const key = canonical(origin)
    const { record, replaced } = ledger.grant(key, capability, patterns, deps.now())
    // Clears a stale revoked-tombstone under THIS id. A freshly minted id
    // makes this a no-op today, but the handle table is correct either way,
    // and open-questions.md A21 says the ledger must call it regardless of
    // how GrantId reuse across a revoke-then-re-grant is eventually decided.
    handleTable.grantIssued(key, record.id)
    // The ledger has already dropped `replaced` (GrantLedger.grant's Map.set
    // above), so this is the only remaining place anything still knows its
    // id. Revoking it here, before returning, is what stops a superseded
    // grant staying live forever -- see the interface doc on `grant`.
    if (replaced !== undefined) await handleTable.revoke(key, replaced.id)
    return record
  }

  async function revoke (origin: string, grantId: GrantId): Promise<void> {
    const key = canonical(origin)
    // Ledger first, synchronously: a grants()/connect() call racing the
    // cascade must never observe a grant whose handles are already mid-
    // teardown. Mirrors HandleTable.revoke's own "tell the app before any
    // teardown runs" ordering, one layer up.
    ledger.revoke(key, grantId)
    await handleTable.revoke(key, grantId)
  }

  return {
    app: { manifest, grants },
    net,
    id,
    fs: { readFile, writeFile, confineSync },
    registerApp,
    versionFloorFor,
    rollbackAcknowledgedVersionFor,
    acknowledgeRollback,
    grant,
    revoke
  }
}
