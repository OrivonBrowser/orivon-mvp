// The read/write shape between `GrantLedger`'s live grants and a
// `LedgerStorage`'s on-disk record (A23, docs/open-questions.md). Split out
// of grant-ledger.ts (code-guidelines.md Rule 2) as its own concern: turning
// untrusted `PersistedGrant` bytes into a live `Grant` a caller may trust, and
// back. Pure -- no origin map, no id-minting policy of its own. See
// README.md's "what a persisted grant may trust" design note for the full
// reasoning this file implements.

import { decideGrantRequest, isCapabilityKind } from '../policy/request-grant.js'
import { isPersistableOrigin } from '../policy/origin.js'
import type { CapabilityKind, Grant, GrantId, Manifest } from '../../contracts/index.js'
import type { LedgerStorage, PersistedGrant } from './ledger-storage.js'

/**
 * Reads whatever `origin` persisted and returns only the entries that still
 * pass `decideGrantRequest` against `manifest` -- the origin's CURRENT one,
 * not whatever was in force when the grant was made.
 *
 * THE SAME CHECK A LIVE REQUEST GETS, reused rather than reimplemented: a
 * restored grant must never hold authority a fresh `requestGrant` call for
 * the same (capability, patterns) would be refused right now. A manifest
 * that narrowed since the grant was made, or dropped the capability
 * entirely, silently drops the restored grant instead of restoring
 * something a live request could not obtain.
 *
 * `newId` mints the fresh GrantId every restored grant gets. Hydration never
 * reuses a persisted id -- there is not one to reuse (`PersistedGrant` carries
 * no `id`) -- so this is simply `GrantLedger.grant`'s own id-minting rule,
 * applied by its caller rather than duplicated here.
 */
export function hydrateGrants (
  storage: LedgerStorage,
  origin: string,
  manifest: Manifest,
  newId: () => GrantId
): ReadonlyMap<CapabilityKind, Grant> {
  const restored = new Map<CapabilityKind, Grant>()
  const persisted = storage.readGrants(origin)
  if (persisted === undefined) return restored

  for (const [key, entry] of Object.entries(persisted)) {
    // UNTRUSTED: a JSON property name off disk, not yet known to be one of
    // the seven real CapabilityKind literals -- a hand-edited or tampered
    // file could name anything.
    if (!isCapabilityKind(key)) continue
    const decision = decideGrantRequest(manifest, key, entry.patterns)
    if (!decision.allowed) continue
    restored.set(key, { id: newId(), origin, capability: key, patterns: decision.patterns, grantedAt: entry.grantedAt })
  }
  return restored
}

/** `GrantLedger`'s live `grants` map, reshaped for `LedgerStorage.writeGrants` -- `id` and `origin` are dropped, since `hydrateGrants` never reads either back. */
export function grantsToPersist (grants: ReadonlyMap<CapabilityKind, Grant>): Readonly<Record<string, PersistedGrant>> {
  const result: Record<string, PersistedGrant> = {}
  for (const [capability, grant] of grants) {
    result[capability] = { patterns: grant.patterns, grantedAt: grant.grantedAt }
  }
  return result
}

/**
 * Writes `grants` in full via `storage.writeGrants` -- the shared write path
 * `GrantLedger.grant`/`revoke` both use. Skipped for a non-persistable origin
 * (T13c) or with `storage` undefined (no `LedgerStorage` injected). THROWS if
 * the write fails: the in-memory change has already landed unconditionally
 * by the time a caller reaches this, so silence here would let a
 * just-revoked grant reappear after a restart with nothing reported.
 */
export function persistGrants (storage: LedgerStorage | undefined, origin: string, grants: ReadonlyMap<CapabilityKind, Grant>): void {
  if (storage === undefined || !isPersistableOrigin(origin)) return
  storage.writeGrants(origin, grantsToPersist(grants))
}

/**
 * Drops every RESTORED grant the given manifest would no longer authorise,
 * and narrows any it only partly covers. `decideGrantRequest` is the same
 * function a live `requestGrant` is decided by, reused rather than
 * reimplemented (Rule 3), so "what a restored grant may hold" and "what a
 * fresh request may obtain" cannot drift apart.
 *
 * ONLY the capabilities in `restored`. `Broker.grant` is the trusted-side
 * call -- the consent prompt and the developer grant -- and is deliberately
 * not manifest-bound; A13 records that re-registering a manifest must leave
 * what it granted alone. A grant read off disk is different: it was validated
 * against a manifest that was also read off disk, so when the app is really
 * opened and its freshly fetched manifest arrives, that check has to run
 * again or an app that narrowed its declaration would keep authority nothing
 * currently asks for.
 */
export function revalidateRestored (
  grants: Map<CapabilityKind, Grant>,
  restored: ReadonlySet<CapabilityKind>,
  manifest: Manifest
): void {
  for (const [capability, grant] of [...grants]) {
    if (!restored.has(capability)) continue
    const decision = decideGrantRequest(manifest, capability, grant.patterns)
    if (!decision.allowed) {
      grants.delete(capability)
      continue
    }
    if (decision.patterns.length !== grant.patterns.length) {
      grants.set(capability, { ...grant, patterns: decision.patterns })
    }
  }
}

/**
 * Reads every origin that has grants persisted and hands each one's manifest
 * and restored grants to `adopt`. Pure reading -- it never writes, which is
 * why `GrantLedger.hydratePersisted` can call it during construction:
 * `registerApp` would also persist the version floor and the manifest, and
 * throws when that write fails, so doing it once per installed app while the
 * broker is still being built would turn a full disk into a browser that
 * cannot start. An origin whose manifest is missing or unparseable is skipped
 * rather than failing the rest.
 */
export function restorePersistedOrigins (
  storage: LedgerStorage,
  newId: () => GrantId,
  adopt: (origin: string, manifest: Manifest, grants: ReadonlyMap<CapabilityKind, Grant>) => void
): void {
  for (const origin of storage.listPersistedOrigins()) {
    const manifest = storage.readManifest(origin)
    if (manifest === undefined) continue
    adopt(origin, manifest, hydrateGrants(storage, origin, manifest, newId))
  }
}
