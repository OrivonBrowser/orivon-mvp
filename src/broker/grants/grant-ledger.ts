// The per-origin state createBroker (../index.ts) holds: GrantLedger is
// the manifest and grants, kept apart on purpose -- see the class doc
// below. createBroker itself is the dependency shape and the five
// capability entry points that consult this ledger.

import type { CapabilityKind, Grant, GrantId, Manifest, Pattern } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'
import type { LedgerStorage } from './ledger-storage.js'
import { isPersistableOrigin } from '../policy/origin.js'
import { decideGrantRequest } from '../policy/request-grant.js'
import { compareVersions } from '../policy/update.js'
import type { ParsedPattern } from '../policy/connect-patterns.js'
import type { ParsedPatternsCache } from './parsed-patterns-cache.js'
import { createParsedPatternsCache } from './parsed-patterns-cache.js'
import { hydrateGrants, persistGrants, restorePersistedOrigins, revalidateRestored } from './grant-persistence.js'

/**
 * 128 bits from the platform CSPRNG, as hex -- same construction as
 * handle-store.ts's private `newHandleId()` (unguessability is defence in
 * depth; the boundary is the per-origin lookup, not the id's secrecy). NOT
 * DEDUPLICATED with that function or policy/bundle-hash.ts's `toLowercaseHex`
 * -- a known, tracked Rule 3 violation (code-guidelines.md's open point 3),
 * not a silent shortcut.
 */
function newGrantId (): GrantId {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface OriginRecord {
  manifest: Manifest | undefined
  /**
   * At most one LIVE grant per capability kind. Granting again replaces it --
   * see `createBroker`'s `grant()` on why the replacement mints a fresh
   * GrantId rather than reusing the old one (open-questions.md A21).
   * Persisted via `LedgerStorage` (A23) -- see README.md's grant-persistence
   * design note for the hydration/re-validation rule.
   */
  readonly grants: Map<CapabilityKind, Grant>
  /** Set once this origin's persisted grants have been checked against its manifest and merged into `grants` -- the first `registerApp` call only, never again (a manifest is required to re-validate against, unlike `versionFloor`'s hydration). */
  grantsHydrated: boolean
  /** The capabilities in `grants` that came from DISK rather than from a
   * `grant()` this session -- the only ones `registerApp` re-checks against a
   * later manifest. The distinction is load-bearing; README.md's
   * grant-persistence design note says why. */
  hydratedCapabilities: Set<CapabilityKind>
  /**
   * Bytes written so far against `manifest.capabilities.fs.quotaBytes`.
   *
   * IN-MEMORY ONLY, and that is a known, filed gap, not an oversight:
   * manifest.ts's contract also promises "reconciling against the directory
   * on startup", which needs a persisted counter and a way to size the
   * confinement directory -- neither exists yet, and `createBroker`'s
   * dependency shape is fixed by build-plan.md, so closing it needs a new
   * `BrokerFs` member. Filed as A29 (cross-cutting.md) rather than built
   * here. This counter still closes the unbounded-write hole for the
   * lifetime of one running session, which is the part that does not need
   * a new dependency to fix.
   */
  fsBytesWritten: number
  /**
   * T19's version floor: the highest version ever installed. `registerApp`
   * is the only writer of a RAISED value; hydration (below) is the only
   * other writer, and only ever raises it too.
   *
   * Persisted via an injected `LedgerStorage` (A57) so it survives a browser
   * restart -- but deliberately NOT a full "remove this app" action, which
   * forgets the origin completely (`ADR-0009`'s 2026-09-04 amendment).
   * `grants` (above) is now ALSO persisted (A23); `fsBytesWritten` still is
   * not (A29).
   */
  versionFloor: string
  /**
   * d-0017 (owner decision): the SPECIFIC below-floor version this origin's
   * rollback was last accepted for, or `undefined` if never acknowledged.
   *
   * NOT A BOOLEAN. A bare "has this origin ever been acknowledged" flag
   * would let accepting one real, presumably-safe rollback (`1.2.0` ->
   * `1.1.9`) silently cover any OTHER below-floor version the same origin
   * later chooses to serve, with no further consent. Recording the specific
   * version lets the caller (a future UI) compare it against whatever
   * below-floor version is being offered now and prompt fresh on anything
   * but an exact match -- this class stores the value, it does not perform
   * that comparison itself.
   *
   * `acknowledgeRollback` is the only writer; hydration (below) is the only
   * other writer. Persisted the same way `versionFloor` is, for the same
   * reason: it must survive a restart, not just this session.
   */
  rollbackAcknowledgedVersion: string | undefined
}

/**
 * The grant ledger: what each origin has declared (its manifest) and what it
 * has actually been granted, kept apart on purpose -- see ../index.ts's file
 * header.
 *
 * DOES NOT ENFORCE that a live `grant()` call is a subset of what the
 * manifest declares -- that is whoever ISSUES the grant's job (the
 * permission prompt, policy/update.ts's re-consent decision). The one
 * exception is a grant RESTORED from disk (A23): `registerApp` re-validates
 * those against the current manifest before they ever reach `grants`.
 *
 * BROKER-INTERNAL, the same way OriginTable (../handles/handle-store.ts) is
 * private to HandleTable -- `canonical()` in index.ts normalises an origin
 * before this class ever sees one.
 */
export class GrantLedger {
  readonly #origins = new Map<string, OriginRecord>()
  readonly #storage: LedgerStorage | undefined
  /** See ./parsed-patterns-cache.ts for what this caches and why keying by the Grant object needs no separate invalidation. */
  readonly #parsedPatterns: ParsedPatternsCache = createParsedPatternsCache()

  /** Optional so every existing caller (every test constructs `GrantLedger()`/`createBroker()` with no persistence in mind) keeps working unchanged -- omitting it is today's in-memory-only behaviour, not a degraded mode. */
  constructor (storage?: LedgerStorage) {
    this.#storage = storage
  }

  #record (origin: string): OriginRecord {
    const existing = this.#origins.get(origin)
    if (existing !== undefined) return existing
    const created: OriginRecord = { manifest: undefined, grants: new Map(), grantsHydrated: false, hydratedCapabilities: new Set(), fsBytesWritten: 0, versionFloor: '0.0.0', rollbackAcknowledgedVersion: undefined }
    this.#origins.set(origin, created)
    this.#hydrateFloor(origin, created)
    this.#hydrateRollbackAcknowledgedVersion(origin, created)
    return created
  }

  /**
   * Loads `origin`'s persisted floor into a freshly created record -- called
   * from `#record`'s create branch only, so BOTH `registerApp` and
   * `versionFloorFor` pick it up on an origin's first touch this session,
   * regardless of which one runs first (`Loader.load()` reads
   * `versionFloorFor` before any registration decision, so hydration must
   * not depend on `registerApp` having already run).
   *
   * Runs at most once per record instance: a record already in `#origins`
   * short-circuits `#record` before this is ever called again for it. The
   * one exception is `forgetOrigin` deleting the record outright, in which
   * case re-hydrating on the origin's next touch is exactly correct -- the
   * whole point of forgetting an origin is to let it compare against
   * whatever is actually on disk afterward, not against a stale in-memory
   * decision from before the forget.
   *
   * A no-op when no `LedgerStorage` was injected, and for an origin
   * `isPersistableOrigin` refuses -- the same gate the write side applies, so
   * T13c holds in both directions. Nothing writes a floor for such an origin
   * today, so this reads as belt-and-braces; it is what stops a floor file
   * that got there some other way (a bug, a hand-edit, a future code path)
   * being honoured for a loopback origin anyway. It also spares a pointless
   * disk read for every localhost origin, which is what this repo's own e2e
   * tests and fixture app run on.
   */
  #hydrateFloor (origin: string, record: OriginRecord): void {
    if (this.#storage === undefined || !isPersistableOrigin(origin)) return
    const persisted = this.#storage.readVersionFloor(origin)
    if (persisted === undefined) return

    if (compareVersions(persisted, persisted) === null) {
      // Corrupt/unparseable (LedgerStorage's own doc contract): applied
      // AS-IS, bypassing the raise-only comparison below entirely, rather
      // than left at '0.0.0'. update.ts's own isAtOrAboveFloor fails closed
      // on a pair compareVersions cannot order -- this is what makes that
      // fire for every future update against this origin, rather than
      // silently reopening T19 by looking identical to "never installed".
      record.versionFloor = persisted
      return
    }
    // Raise only, never lower -- same rule registerApp enforces below. A
    // freshly created record's default ('0.0.0') is always at or below any
    // valid persisted floor, so this only ever raises in practice; written
    // as a real comparison anyway rather than an unconditional assignment,
    // so it can never regress if that default ever changes.
    if (compareVersions(persisted, record.versionFloor) === 1) record.versionFloor = persisted
  }

  /**
   * d-0017's counterpart to `#hydrateFloor`, same call site and same reason:
   * a record created for an origin queried before `acknowledgeRollback` ever
   * ran this session must still see what a previous session persisted.
   *
   * A read of `undefined` (never persisted, or a corrupt record --
   * `LedgerStorage.readAcknowledgedRollbackVersion`'s own contract collapses
   * both to the same value) leaves the freshly-created record's default
   * `undefined` untouched. There is no raise-only comparison needed the way
   * the floor's does: unlike a version ordering, there is no "lower" value
   * than "never acknowledged" to protect against, and this class does not
   * itself judge whether one acknowledged version is more or less permissive
   * than another -- it only remembers the one most recently accepted.
   */
  #hydrateRollbackAcknowledgedVersion (origin: string, record: OriginRecord): void {
    if (this.#storage === undefined || !isPersistableOrigin(origin)) return
    const persisted = this.#storage.readAcknowledgedRollbackVersion(origin)
    if (persisted !== undefined) record.rollbackAcknowledgedVersion = persisted
  }

  /**
   * Registers -- or replaces -- an origin's manifest. Existing grants are
   * left untouched: a page reload re-declares the same manifest and must not
   * silently revoke what the user already granted it.
   *
   * RAISES THE VERSION FLOOR to `manifest.version`, never lowers it --
   * `compareVersions` returning anything but 1 (including null, an
   * unparseable version `parseManifest` should already have refused
   * upstream) leaves the floor exactly where it was. This is the only writer
   * of a raised `versionFloor` (hydration above only ever applies what was
   * already persisted); T19's replay guard depends on every registration
   * going through here.
   *
   * THE IN-MEMORY RAISE HAPPENS FIRST, AND IS UNCONDITIONAL -- nothing about
   * persistence may delay or skip it, or a failed write leaves this session
   * accepting a replay of the superseded version.
   *
   * Persists afterward (A57), only when the floor actually moves, and never
   * for an origin `isPersistableOrigin` refuses (A23/T13c). THROWS if that
   * write fails, after the raise has already landed -- reported rather than
   * silent. README.md's design notes carry the reasoning for both.
   */
  registerApp (origin: string, manifest: Manifest): void {
    const record = this.#record(origin)
    record.manifest = manifest

    // First registration this session only -- see `grantsHydrated`'s doc.
    if (!record.grantsHydrated) {
      record.grantsHydrated = true
      if (this.#storage !== undefined && isPersistableOrigin(origin)) {
        for (const [capability, grant] of hydrateGrants(this.#storage, origin, manifest, newGrantId)) {
          record.grants.set(capability, grant)
          record.hydratedCapabilities.add(capability)
        }
      }
    } else {
      // Restored grants only -- see `hydratedCapabilities`. Startup hydration
      // validates against the manifest on disk; this is where that decision
      // gets re-taken against the one the app actually serves.
      revalidateRestored(record.grants, record.hydratedCapabilities, manifest)
    }

    if (compareVersions(manifest.version, record.versionFloor) !== 1) return

    record.versionFloor = manifest.version

    if (this.#storage !== undefined && isPersistableOrigin(origin)) {
      this.#storage.writeVersionFloor(origin, manifest.version)
      // What the user approved, kept so the permissions list can name this
      // app after a restart without asking its server again.
      this.#storage.writeManifest(origin, manifest)
    }
  }


  /** Brings back every origin with grants persisted, so the settings
   * permissions list is populated at launch rather than only after an app is
   * opened (C-01/C-02). Called once, from `createBroker`. */
  hydratePersisted (): void {
    if (this.#storage === undefined) return
    restorePersistedOrigins(this.#storage, newGrantId, (origin, manifest, restored) => {
      const record = this.#record(origin)
      if (record.grantsHydrated) return
      record.manifest = manifest
      record.grantsHydrated = true
      for (const [capability, grant] of restored) {
        record.grants.set(capability, grant)
        record.hydratedCapabilities.add(capability)
      }
    })
  }

  /**
   * A60's escape hatch: the only way a poisoned version floor comes back
   * down. Three rules a maintainer must not reorder -- DISK FIRST, then
   * memory; memory left untouched if any delete fails, so a failed forget
   * changes nothing; and never a throw, the delete failure is logged
   * instead. README.md's grant-persistence design note carries the
   * reasoning for each, and what this deliberately is NOT.
   */
  forgetOrigin (origin: string): void {
    if (this.#storage !== undefined) {
      try {
        // All three persisted pieces go together, disk-then-memory as above:
        // if ANY delete throws, the in-memory record is left completely
        // intact rather than half-forgotten -- best-effort across the four
        // files, not a filesystem transaction.
        this.#storage.deleteVersionFloor(origin)
        this.#storage.deleteAcknowledgedRollbackVersion(origin)
        this.#storage.deleteGrants(origin)
        // Last, and it matters that it is last: while the manifest is still
        // on disk the origin can be listed in settings, which is the only
        // place a person can see that a forget half-failed.
        this.#storage.deleteManifest(origin)
      } catch (error) {
        console.error('[broker] failed to delete a persisted version floor, rollback acknowledgement, grant set or manifest; the in-memory record was left intact so nothing is half-forgotten', error)
        return
      }
    }
    this.#origins.delete(origin)
  }

  /** Every origin this ledger has a manifest for -- what the settings
   * permissions list enumerates. */
  registeredOrigins (): readonly string[] {
    const found: string[] = []
    for (const [origin, record] of this.#origins) {
      if (record.manifest !== undefined) found.push(origin)
    }
    return found
  }

  manifestFor (origin: string): Manifest | undefined {
    return this.#origins.get(origin)?.manifest
  }

  /**
   * T19: the highest version ever installed for this origin. `'0.0.0'` for
   * one never registered NOR ever persisted. Routes through `#record`
   * (rather than a plain `#origins.get`) so an origin queried for the first
   * time this session -- before `registerApp` has run at all -- still
   * hydrates from `LedgerStorage` first; the only externally visible effect
   * of that is an in-memory record now existing for a merely-queried
   * origin, which every other method already treats identically to "no
   * record at all" (empty grants, undefined manifest).
   */
  versionFloorFor (origin: string): string {
    return this.#record(origin).versionFloor
  }

  /**
   * d-0017: the SPECIFIC below-floor version this origin's rollback was
   * last accepted for, or `undefined` if never acknowledged (or if the
   * persisted record was corrupt -- `LedgerStorage.
   * readAcknowledgedRollbackVersion`'s own doc explains why that collapse is
   * the only safe one). Routes through `#record` for the same reason
   * `versionFloorFor` does: a first-ever query must hydrate before the
   * caller (a future UI-wiring PR) decides whether to prompt. The caller is
   * responsible for the actual "is this the version I am about to offer"
   * comparison -- this class only remembers the value.
   */
  rollbackAcknowledgedVersionFor (origin: string): string | undefined {
    return this.#record(origin).rollbackAcknowledgedVersion
  }

  /**
   * Records that `origin`'s rollback to `version` has been acknowledged
   * (d-0017) -- called once, when the user actually chooses to accept that
   * specific below-floor version. This class never calls it on its own
   * initiative; the caller (a future UI) decides WHEN that choice was made
   * and WHICH version it was for. Overwrites
   * whatever version was previously acknowledged for this origin -- one
   * acknowledgement in force at a time, same shape as `registerApp`
   * replacing a manifest.
   *
   * Mirrors `registerApp`'s ordering exactly, for the same reason: the
   * in-memory value is set FIRST and unconditionally, and persistence is
   * attempted only after -- so a failed write still leaves this session not
   * re-prompting for the version just accepted, matching a no-persistence
   * ledger's own behaviour, rather than regressing to "prompt again" the
   * moment disk trouble strikes. THROWS if the write fails, same shape as
   * `registerApp`'s own throw; `Broker.acknowledgeRollback` (../index.ts)
   * turns that into the same rejected-promise shape every other Broker
   * method already uses.
   */
  acknowledgeRollback (origin: string, version: string): void {
    const record = this.#record(origin)
    record.rollbackAcknowledgedVersion = version

    if (this.#storage !== undefined && isPersistableOrigin(origin)) {
      this.#storage.writeAcknowledgedRollbackVersion(origin, version)
    }
  }

  /** What was ACTUALLY granted. Empty for an origin the ledger has no record of. */
  grantsFor (origin: string): readonly Grant[] {
    const record = this.#origins.get(origin)
    return record === undefined ? [] : Array.from(record.grants.values())
  }

  /** The live grant for one capability kind, or undefined if none was ever issued or it was revoked. */
  currentGrant (origin: string, capability: CapabilityKind): Grant | undefined {
    return this.#origins.get(origin)?.grants.get(capability)
  }

  /**
   * `grant.patterns`, already split into ParsedPattern (./parsed-patterns-cache.ts).
   *
   * TAKES A Grant, NOT A GrantId. The id alone cannot answer this once a
   * grant has been revoked or replaced, and re-deriving "the current grant
   * for this id" would just be `currentGrant` again -- the caller already
   * has the Grant it wants patterns for (typically straight out of
   * `currentGrant`), so this only ever adds a cache lookup, never a second
   * ledger read.
   */
  parsedPatternsFor (grant: Grant): ReadonlyArray<ParsedPattern | null> {
    return this.#parsedPatterns.get(grant)
  }

  /**
   * Records a capability as granted, replacing any earlier grant of the same
   * kind. Returns the replaced record too -- the ledger is the only thing
   * that ever held it, so a caller that needs to revoke it (createBroker's
   * `grant`, in index.ts) has no other way to find it once this returns.
   * Persists via `persistGrants` (A23, ./grant-persistence.ts) -- see its doc.
   */
  grant (origin: string, capability: CapabilityKind, patterns: readonly Pattern[], grantedAt: number): { record: Grant, replaced: Grant | undefined } {
    const record: Grant = { id: newGrantId(), origin, capability, patterns, grantedAt }
    const originRecord = this.#record(origin)
    const replaced = originRecord.grants.get(capability)
    originRecord.grants.set(capability, record)
    persistGrants(this.#storage, origin, originRecord.grants)
    return { record, replaced }
  }

  /**
   * Removes one grant, by id, from whichever capability slot holds it, and
   * persists the removal via `persistGrants` (A23) -- which DOES throw on a
   * write failure, unlike the no-op contract below.
   *
   * A NO-OP, never a throw, for an origin or id the ledger does not hold --
   * revoking twice, or revoking an id that already lapsed, must behave the
   * same as HandleTable.release's idempotence, not surface a distinguishable
   * error an app-adjacent caller could probe with.
   */
  revoke (origin: string, grantId: GrantId): void {
    const record = this.#origins.get(origin)
    if (record === undefined) return
    for (const [capability, grant] of record.grants) {
      if (grant.id === grantId) {
        record.grants.delete(capability)
        persistGrants(this.#storage, origin, record.grants)
        return
      }
    }
  }

  /**
   * How many sockets this origin may hold at once: what its manifest declared
   * (`net.concurrentSockets`), clamped to `LIMITS.concurrentSockets`, or
   * `LIMITS.defaultConcurrentSockets` when it declared nothing.
   *
   * CLAMPED, not rejected, and the manifest validator deliberately accepts a
   * larger number for the same reason: changing the platform ceiling must
   * never turn an already-published manifest into an invalid one.
   *
   * Reads through `#origins.get`, not `#record`, so merely asking about an
   * origin does not create a row for it -- same as `fsBytesWritten` below.
   */
  socketAllowance (origin: string): number {
    const declared = this.#origins.get(origin)?.manifest?.capabilities.net?.concurrentSockets
    if (declared === undefined) return LIMITS.defaultConcurrentSockets
    return Math.min(declared, LIMITS.concurrentSockets)
  }

  /** Bytes already reserved (written, or still in flight) against `origin`'s quota this session. Zero for an origin the ledger has no record of yet. */
  fsBytesWritten (origin: string): number {
    return this.#origins.get(origin)?.fsBytesWritten ?? 0
  }

  /**
   * The quota check AND the reservation, as one synchronous step. Reading
   * the counter and only updating it later -- after an `await` -- lets every
   * concurrent caller observe the same pre-write value and all pass; the
   * ONLY thing that closes that gap is doing both in the same synchronous
   * turn, before anything yields to another call. No lock is needed for
   * that: JavaScript does not interleave two synchronous stretches of code,
   * only what sits either side of an `await`.
   *
   * Returns false, reserving nothing, when `bytes` would push the running
   * total over `quotaBytes`. Reserves unconditionally (and returns true)
   * when the origin has no declared quota -- `quotaBytes?: number` is
   * optional -- mirroring the old unconditional counter, so a quota added
   * to the manifest later still sees every byte written before it existed.
   *
   * The caller must call `releaseFsBytes` for whatever it reserved here if
   * the write does not end up landing.
   */
  reserveFsBytes (origin: string, bytes: number): boolean {
    const record = this.#record(origin)
    const quotaBytes = record.manifest?.capabilities.fs?.quotaBytes
    if (quotaBytes !== undefined && record.fsBytesWritten + bytes > quotaBytes) return false
    record.fsBytesWritten += bytes
    return true
  }

  /**
   * Refunds a reservation `reserveFsBytes` made for a write that did not
   * land -- refused before the real I/O ran, or that I/O itself rejected.
   * Clamped at zero rather than trusted to balance exactly, so a mismatched
   * caller degrades to an over-strict quota instead of a negative counter
   * that would then let a future write past the real limit.
   */
  releaseFsBytes (origin: string, bytes: number): void {
    const record = this.#record(origin)
    record.fsBytesWritten = Math.max(0, record.fsBytesWritten - bytes)
  }
}
