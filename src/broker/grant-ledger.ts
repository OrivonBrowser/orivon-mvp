// Split out of ./index.ts (docs/development/code-guidelines.md Rule 2 --
// index.ts crossed its 500-line budget once the fixes in pr-31.md's review
// landed). This is the seam that file's own header anticipated: GrantLedger
// is the per-origin state (manifest and grants, kept apart on purpose --
// see the class doc below), createBroker is the dependency shape and the
// five capability entry points that consult it. No behaviour changed in
// this split; only the file it lives in.

import type { CapabilityKind, Grant, GrantId, Manifest, Pattern } from '../contracts/index.js'

/**
 * 128 bits from the platform CSPRNG, as hex -- the same construction
 * handle-store.ts's private `newHandleId()` uses, for the same reason
 * (unguessability is defence in depth; the boundary is the per-origin
 * lookup, not the id's secrecy).
 *
 * NOT DEDUPLICATED with that function, or with policy/bundle-hash.ts's
 * private `toLowercaseHex`. Both live in files this task may not touch --
 * policy/ is off limits by the task brief, and handle-store.ts is not one of
 * the two files it may create -- so reusing either would need an edit outside
 * this PR's scope. code-guidelines.md Rule 3's open point 3 already tracks
 * one such pair as a deliberate, left-for-a-follow-up duplicate; this is the
 * same shape of trade-off, not a new kind of one. Flagged in the PR body as
 * an AI recommendation, not a silent shortcut.
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

  #record (origin: string): OriginRecord {
    const existing = this.#origins.get(origin)
    if (existing !== undefined) return existing
    const created: OriginRecord = { manifest: undefined, grants: new Map() }
    this.#origins.set(origin, created)
    return created
  }

  /**
   * Registers -- or replaces -- an origin's manifest. Existing grants are
   * left untouched: a page reload re-declares the same manifest and must not
   * silently revoke what the user already granted it.
   */
  registerApp (origin: string, manifest: Manifest): void {
    this.#record(origin).manifest = manifest
  }

  manifestFor (origin: string): Manifest | undefined {
    return this.#origins.get(origin)?.manifest
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
}
