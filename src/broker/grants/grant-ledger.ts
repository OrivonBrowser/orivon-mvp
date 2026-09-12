// The per-origin state createBroker (../index.ts) holds: GrantLedger is
// the manifest and grants, kept apart on purpose -- see the class doc
// below. createBroker itself is the dependency shape and the five
// capability entry points that consult this ledger.

import type { CapabilityKind, Grant, GrantId, Manifest, Pattern } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'
import type { LedgerStorage } from './ledger-storage.js'
import { isPersistableOrigin } from '../policy/origin.js'
import { acknowledgeRollback, hydrateFloor, hydrateRollbackAcknowledgedVersion, raiseFloor } from './update-safety.js'
import type { ParsedPattern } from '../policy/connect-patterns.js'
import type { ParsedPatternsCache } from './parsed-patterns-cache.js'
import { createParsedPatternsCache } from './parsed-patterns-cache.js'
import { hydrateGrants, persistGrants } from './grant-persistence.js'

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
    const created: OriginRecord = { manifest: undefined, grants: new Map(), grantsHydrated: false, fsBytesWritten: 0, versionFloor: '0.0.0', rollbackAcknowledgedVersion: undefined }
    this.#origins.set(origin, created)
    hydrateFloor(this.#storage, origin, created)
    hydrateRollbackAcknowledgedVersion(this.#storage, origin, created)
    return created
  }


  /**
   * Registers -- or replaces -- an origin's manifest. Existing grants are
   * left untouched: a page reload re-declares the same manifest and must not
   * silently revoke what the user already granted it.
   *
   * RAISES THE VERSION FLOOR, never lowers it, and is the only caller that
   * does -- T19's replay guard depends on every registration coming through
   * here. The rule itself, and what it does with an unorderable version,
   * lives in ./update-safety.ts's `raiseFloor`.
   *
   * THE IN-MEMORY RAISE HAPPENS FIRST, AND IS UNCONDITIONAL. Nothing about
   * persistence may delay or skip it. A ledger with no `LedgerStorage` at
   * all already guarantees that much, and a ledger WITH one must never be
   * weaker: hold the raise back until a write succeeds, and a failed write
   * leaves this session's floor at the superseded version -- so the same
   * session accepts a replay of it, with no restart involved and nothing
   * visible. That is a worse hole than the one persistence closes.
   *
   * Persists the raised value afterward via `LedgerStorage` (A57) so it
   * survives a restart -- only when the floor actually moves, so an ordinary
   * page reload that re-declares the same version never touches disk, and
   * never at all for an origin `isPersistableOrigin` refuses (A23/T13c:
   * loopback and plain-http origins are session-scoped only).
   *
   * THROWS if that write fails (EACCES, ENOSPC, EROFS), after the raise has
   * already landed. The residual risk is then A57's original one and no
   * worse -- a restart while writes keep failing hydrates the older on-disk
   * value -- but it is reported instead of silent. `Broker.registerApp`
   * (../index.ts) turns this into the rejected promise every other method on
   * that surface already produces.
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
        }
      }
    }

    // One writer for the raise-only rule and its persistence, shared with
    // nothing else -- see ./update-safety.ts. Returns false when the floor did
    // not move, which is the ordinary page-reload case and must not touch disk.
    raiseFloor(this.#storage, origin, record, manifest.version)
  }

  /**
   * A60's escape hatch. `registerApp` raises the floor unconditionally, even
   * for a manifest that was only ever FETCHED, never actually installed --
   * so a hostile origin can poison the floor with a fake high version and
   * lock the user out of every real, lower-numbered future update from it.
   * Nothing else in this class lowers, resets or clears a floor once raised.
   * This is the only way back: it clears the in-memory record and deletes
   * whatever `LedgerStorage` persisted, so a subsequent registration for
   * this origin starts at '0.0.0' again, on disk as well as in memory.
   *
   * BOTH have to go together. Clearing only memory would let the next
   * hydration read the poisoned value straight back off disk; clearing only
   * disk would leave the poisoned value live for the rest of this session.
   * DISK FIRST, then memory, and memory is left untouched if the delete
   * fails: clearing memory first means a failed delete leaves the poisoned
   * floor on disk with nothing in memory to compare it against -- a state
   * strictly worse than never having called this at all. A failed forget
   * must change nothing.
   *
   * The delete failing is LOGGED, NOT THROWN, unlike `registerApp`'s write
   * above. The two are not held to one standard because they carry different
   * risk: `registerApp`'s write is the security-critical half of a raise that
   * already happened, so hiding its failure hides a real weakening. This is
   * best-effort cleanup, and its failure leaves the ledger exactly as it was
   * -- still safe, just still poisoned, which is the state the caller was
   * already in.
   *
   * Never a throw. With no `LedgerStorage` injected it still clears the
   * in-memory record -- there is simply no disk half to clear. For an origin
   * the ledger holds nothing for it is a no-op both halves.
   *
   * NOT AN "UNINSTALL THIS APP" PRIMITIVE. It is correct and complete for the
   * version floor and the persisted grants (A23) -- `deleteGrants` below
   * closes that half, matching `ADR-0009`'s 2026-09-04 amendment that a full
   * removal forgets everything. In-memory `manifest` and `fsBytesWritten` are
   * also dropped, and two gaps remain open, neither reachable today since
   * NOTHING CALLS THIS YET (docs/open-questions.md A60):
   *   - dropping a grant here does not revoke the handles it authorised --
   *     that cascade belongs one layer up, in `createBroker`, next to the one
   *     `revoke` already performs (this class has no `HandleTable` reference).
   *   - resetting `fsBytesWritten` to zero frees no bytes on disk, so
   *     forget-then-re-register is a way around the fs quota until the
   *     confinement directory is actually sized (A29).
   */
  forgetOrigin (origin: string): void {
    if (this.#storage !== undefined) {
      try {
        // All three persisted pieces go together, disk-then-memory as above:
        // if ANY delete throws, the in-memory record is left completely
        // intact rather than half-forgotten -- best-effort across the three
        // files, not a filesystem transaction.
        this.#storage.deleteVersionFloor(origin)
        this.#storage.deleteAcknowledgedRollbackVersion(origin)
        this.#storage.deleteGrants(origin)
      } catch (error) {
        console.error('[broker] failed to delete a persisted version floor, rollback acknowledgement or grant set; the in-memory record was left intact so nothing is half-forgotten', error)
        return
      }
    }
    this.#origins.delete(origin)
  }

  manifestFor (origin: string): Manifest | undefined {
    return this.#origins.get(origin)?.manifest
  }


  /** T19's floor: the highest version ever installed for this origin, `'0.0.0'`
   * if never registered nor persisted. The rules live in ./update-safety.ts. */
  versionFloorFor (origin: string): string {
    return this.#record(origin).versionFloor
  }

  /** The specific below-floor version this origin's rollback was last
   * acknowledged for (d-0017), or undefined. NOT a boolean -- a corrupt read
   * collapsing to undefined must read as "never acknowledged". */
  rollbackAcknowledgedVersionFor (origin: string): string | undefined {
    return this.#record(origin).rollbackAcknowledgedVersion
  }

  /** Records that the user accepted a below-floor version (d-0017). Throws if
   * the write fails, after the in-memory change has landed -- same shape as
   * `registerApp`. */
  acknowledgeRollback (origin: string, version: string): void {
    acknowledgeRollback(this.#storage, origin, this.#record(origin), version)
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
