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

import type { PersistedApp } from './grants/ledger-storage.js'
import { HandleTable } from './handles/handles.js'
import { errnoOf, fail } from './errors.js'
import { GrantLedger } from './grants/grant-ledger.js'
import { originFromUrl } from './policy/origin.js'
import { createNetCapability } from './net-capability.js'
import { createIdCapability } from './id-capability.js'
import { createFsCapability } from './fs-capability.js'
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

  // orivon.net's three entry points. Lifted to ./net-capability.ts once
  // `listen` pushed this file past Rule 2's 500 lines -- see that file's own
  // header, and README.md's design notes, for why the split lands here.
  const net = createNetCapability({ deps, handleTable, ledger, canonical })

  // orivon.id's two entry points (publicKey, sign) -- built alongside
  // net-capability.ts from the start rather than inlined here first, for
  // the same Rule 2 reason: this file was already 264 lines before `id`.
  const id = createIdCapability({ deps, ledger, canonical })

  // orivon.fs's eight entry points -- readFile, writeFile, confineSync
  // (ADR-0016) plus queue item 2.1's mkdir/readdir/stat/rm/rename. Lifted to
  // ./fs-capability.ts for the same Rule 2 reason net/id were: see that
  // file's own header for the confinement guarantee every one of them shares.
  const fs = createFsCapability({ deps, handleTable, ledger, canonical })

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
   * SYNCHRONOUS, unlike every other `app.*` method -- `main.ts`'s tab
   * construction (`src/main/tabs.ts`) runs in the SAME process as this
   * broker, with no IPC round trip to await, and needs an answer before
   * `WebContentsView` construction so it can hand a fixed, preload-readable
   * flag over via `webPreferences.additionalArguments` (the same mechanism
   * `newtab.ts` already uses for its own dashboard-URL check). `confineSync`
   * (`./fs-capability.ts`) is the precedent for a synchronous sibling of an
   * already-async method answering the same in-memory ledger state.
   *
   * Reads `ledger.manifestFor` directly, exactly what the async `manifest`
   * above does before it throws -- "registered" means exactly "has a
   * manifest", nothing more (a registered app may still hold zero grants).
   * Never throws: an invalid origin string is simply "not registered",
   * because the caller here is UI plumbing deciding whether to route
   * `fetch()`, not a capability check standing between an app and a
   * resource -- a wrong answer costs a preload's own async fallback path,
   * never a security boundary.
   */
  function registeredOriginsSync (): readonly string[] {
    return ledger.registeredOrigins()
  }

  /** Display only -- see Broker.app.persistedAppsSync and A137. No canonicalisation
   * needed or wanted: these origins come back from storage having already been
   * checked to re-hash to their own directory, and nothing here authorises. */
  function persistedAppsSync (): readonly PersistedApp[] {
    return ledger.persistedApps()
  }

  function isRegisteredSync (origin: string): boolean {
    const key = originFromUrl(origin)
    if (key === null) return false
    return ledger.manifestFor(key) !== undefined
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

  /**
   * `GrantLedger.grant` (A23) can throw when persisting the new grant set
   * fails, AFTER its in-memory mutation has already landed (that method's own
   * doc). The handle-table bookkeeping below -- clearing this id's tombstone,
   * revoking whatever this grant replaced -- must run REGARDLESS of that
   * persistence outcome: it is what keeps `HandleTable` in step with the
   * ledger's own in-memory truth, and a disk failure must never be the reason
   * a superseded grant's handles are left running past the ledger's own
   * decision to drop them (see the interface doc on `grant`). So the write is
   * attempted, its outcome remembered, the handle-table work always
   * performed, and only THEN, if the write failed, is the OrivonError thrown
   * -- same rethrow shape `registerApp`/`acknowledgeRollback` use, just
   * deferred past this method's own required side effects.
   */
  /** Revokes by (origin, capability) so the settings list can revoke an app
   * that is not loaded. Mirrors `revoke`'s own canonicalisation, and returns
   * whether anything was removed rather than resolving silently either way. */
  async function revokePersisted (origin: string, capability: CapabilityKind): Promise<boolean> {
    return ledger.revokePersisted(canonical(origin), capability)
  }

  async function grant (origin: string, capability: CapabilityKind, patterns: readonly Pattern[]): Promise<Grant> {
    const key = canonical(origin)
    // Captured BEFORE the call below: GrantLedger.grant's own Map.set already
    // drops this from the ledger, so this is the only chance to learn it.
    const replaced = ledger.currentGrant(key, capability)
    let persistError: unknown
    try {
      ledger.grant(key, capability, patterns, deps.now())
    } catch (error) {
      persistError = error
    }
    // Re-read rather than trust the (possibly-thrown-away) return value: the
    // mutation above lands unconditionally even when the try/catch caught a
    // persistence failure, so the ledger's own map is the source of truth.
    const record = ledger.currentGrant(key, capability)
    if (record === undefined) throw fail('internal', 'the grant did not take effect')
    // Clears a stale revoked-tombstone under THIS id. A freshly minted id
    // makes this a no-op today, but the handle table is correct either way,
    // and open-questions.md A21 says the ledger must call it regardless of
    // how GrantId reuse across a revoke-then-re-grant is eventually decided.
    handleTable.grantIssued(key, record.id)
    // Revoking the superseded grant's handles, before returning, is what
    // stops it staying live forever -- see the interface doc on `grant`.
    if (replaced !== undefined) await handleTable.revoke(key, replaced.id)
    if (persistError !== undefined) throw fail('internal', 'the grant could not be persisted', undefined, errnoOf(persistError))
    return record
  }

  /**
   * Same deferred-throw shape as `grant` above, for the same reason:
   * `GrantLedger.revoke` (A23) can throw when persisting the removal fails,
   * after applying it in memory, but `handleTable.revoke` below must still
   * run regardless -- a disk failure must never be the reason a REVOKED
   * grant's handles (an open socket, a listener) are left running. The
   * ledger's own OrivonError is thrown only after that teardown completes.
   */
  async function revoke (origin: string, grantId: GrantId): Promise<void> {
    const key = canonical(origin)
    let persistError: unknown
    try {
      // Ledger first, synchronously: a grants()/connect() call racing the
      // cascade must never observe a grant whose handles are already mid-
      // teardown. Mirrors HandleTable.revoke's own "tell the app before any
      // teardown runs" ordering, one layer up.
      ledger.revoke(key, grantId)
    } catch (error) {
      persistError = error
    }
    await handleTable.revoke(key, grantId)
    if (persistError !== undefined) throw fail('internal', 'the revocation could not be persisted', undefined, errnoOf(persistError))
  }

  return {
    app: { manifest, grants, isRegisteredSync, registeredOriginsSync, persistedAppsSync },
    net,
    id,
    fs,
    registerApp,
    versionFloorFor,
    rollbackAcknowledgedVersionFor,
    acknowledgeRollback,
    grant,
    revoke,
    revokePersisted
  }
}
