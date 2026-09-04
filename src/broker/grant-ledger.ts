// Split out of ./index.ts (docs/development/code-guidelines.md Rule 2 --
// index.ts crossed its 500-line budget once the fixes in pr-31.md's review
// landed). This is the seam that file's own header anticipated: GrantLedger
// is the per-origin state (manifest and grants, kept apart on purpose --
// see the class doc below), createBroker is the dependency shape and the
// five capability entry points that consult it. No behaviour changed in
// this split; only the file it lives in.

import type { CapabilityKind, Grant, GrantId, Manifest, Pattern } from '../contracts/index.js'
import type { LedgerStorage } from './ledger-storage.js'
import { compareVersions } from './policy/update.js'

/**
 * 128 bits from the platform CSPRNG, as hex -- the same construction
 * handle-store.ts's private `newHandleId()` uses, for the same reason
 * (unguessability is defence in depth; the boundary is the per-origin
 * lookup, not the id's secrecy).
 *
 * NOT DEDUPLICATED with that function, or with policy/bundle-hash.ts's
 * private `toLowercaseHex` -- three copies of the same hex encoding. A known,
 * deliberate Rule 3 violation, tracked in code-guidelines.md's open point 3
 * along with the pair it belongs to, and not a silent shortcut.
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
   */
  readonly grants: Map<CapabilityKind, Grant>
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
   * Persisted via an injected `LedgerStorage` (A57, `docs/open-questions.md`)
   * so it survives a browser restart, not just an app's own uninstall --
   * `ADR-0009` requires exactly that. Deliberately NOT persisted the rest of
   * `OriginRecord` (`manifest`, `grants`, `fsBytesWritten`): full ledger
   * persistence is separate, larger, not-yet-built work (A23's own "when the
   * code that persists grants exists"); this closes only the specific T19
   * replay-guard gap A57 is about.
   */
  versionFloor: string
}

/**
 * The grant ledger: what each origin has declared (its manifest) and what it
 * has actually been granted, kept apart on purpose -- see ./index.ts's file
 * header.
 *
 * DOES NOT ENFORCE that a grant is a subset of what the manifest declares.
 * That check belongs to whoever ISSUES the grant (the permission-prompt UI, a
 * later build step) and to policy/update.ts's re-consent decision. This class
 * only remembers what it is told, the same way HandleTable trusts the
 * ownership its caller asserts rather than re-deriving it.
 *
 * BROKER-INTERNAL, the same way OriginTable (./handle-store.ts) is private to
 * HandleTable. Nothing outside `createBroker` should hold a bare
 * GrantLedger; `canonical()` in index.ts is the boundary that normalises an
 * origin before this class ever sees one.
 */
export class GrantLedger {
  readonly #origins = new Map<string, OriginRecord>()
  readonly #storage: LedgerStorage | undefined
  readonly #hydrated = new Set<string>()

  /**
   * `storage` is optional so every existing caller (every test in this
   * codebase constructs `GrantLedger()`/`createBroker()` with no persistence
   * in mind) keeps working unchanged -- omitting it is exactly today's
   * in-memory-only behaviour, not a degraded mode.
   */
  constructor (storage?: LedgerStorage) {
    this.#storage = storage
  }

  #record (origin: string): OriginRecord {
    const existing = this.#origins.get(origin)
    if (existing !== undefined) return existing
    const created: OriginRecord = { manifest: undefined, grants: new Map(), fsBytesWritten: 0, versionFloor: '0.0.0' }
    this.#origins.set(origin, created)
    this.#hydrateFloor(origin, created)
    return created
  }

  /**
   * Loads `origin`'s persisted floor into the freshly created record, once
   * per origin per process -- called from `#record` itself so BOTH
   * `registerApp` and `versionFloorFor` pick it up on an origin's first
   * touch this session, regardless of which one runs first (`Loader.load()`
   * reads `versionFloorFor` before any registration decision, so hydration
   * must not depend on `registerApp` having already run).
   *
   * A no-op when no `LedgerStorage` was injected, or once already run for
   * this origin this session -- `#hydrated` prevents a second disk read
   * from ever re-applying a stale value over one `registerApp` already
   * raised in memory since.
   */
  #hydrateFloor (origin: string, record: OriginRecord): void {
    if (this.#storage === undefined || this.#hydrated.has(origin)) return
    this.#hydrated.add(origin)
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
   * going through here. Persists the raised value via `LedgerStorage`
   * (A57) so it survives a restart -- only when it actually moves, not on
   * every call, so an ordinary page reload that re-declares the same
   * version never touches disk.
   */
  registerApp (origin: string, manifest: Manifest): void {
    const record = this.#record(origin)
    record.manifest = manifest
    if (compareVersions(manifest.version, record.versionFloor) === 1) {
      record.versionFloor = manifest.version
      this.#storage?.writeVersionFloor(origin, record.versionFloor)
    }
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
   * Records a capability as granted, replacing any earlier grant of the same
   * kind. Returns the replaced record too -- the ledger is the only thing
   * that ever held it, so a caller that needs to revoke it (createBroker's
   * `grant`, in index.ts) has no other way to find it once this returns.
   */
  grant (origin: string, capability: CapabilityKind, patterns: readonly Pattern[], grantedAt: number): { record: Grant, replaced: Grant | undefined } {
    const record: Grant = { id: newGrantId(), origin, capability, patterns, grantedAt }
    const originRecord = this.#record(origin)
    const replaced = originRecord.grants.get(capability)
    originRecord.grants.set(capability, record)
    return { record, replaced }
  }

  /**
   * Removes one grant, by id, from whichever capability slot holds it.
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
        return
      }
    }
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
