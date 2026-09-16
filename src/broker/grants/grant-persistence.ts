// The read/write shape between `GrantLedger`'s live grants and a
// `LedgerStorage`'s on-disk record (A23, docs/open-questions.md). Split out
// of grant-ledger.ts (code-guidelines.md Rule 2) as its own concern: turning
// untrusted `PersistedGrant` bytes into a live `Grant` a caller may trust, and
// back. Pure -- no origin map, no id-minting policy of its own. See
// README.md's "what a persisted grant may trust" design note for the full
// reasoning this file implements.

import { decideGrantRequest, isCapabilityKind } from '../policy/request-grant.js'
import { isPersistableOrigin } from '../policy/origin.js'
import { sameOwnPatterns } from '../policy/update.js'
import type { CapabilityKind, Grant, GrantId, Manifest } from '../../contracts/index.js'
import type { LedgerStorage, PersistedGrant } from './ledger-storage.js'

/**
 * One capability whose LIVE grant a hydration pass replaced with genuinely
 * different authority -- either a new id (narrowed, or the persisted patterns
 * no longer fit the current manifest at all) or nothing (the capability was
 * dropped outright). `grantId` is the SUPERSEDED id, exactly what
 * `HandleTable.revoke` (../handles/handles.js) needs to tear down whatever
 * that id still authorises -- `GrantLedger` has no `HandleTable` reference
 * (README.md), so it can only report this list; `../index.ts`'s
 * `createBroker` wrapper is what actually cascades it (A168).
 */
export interface SupersededGrant {
  readonly capability: CapabilityKind
  readonly grantId: GrantId
}

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

/**
 * Clears `grants` and repopulates it from `hydrateGrants` -- the shared
 * "REPLACE, never merge" step `GrantLedger.registerApp` and its early
 * counterpart `hydrateFromPinnedManifest` (A158) both need: whichever call
 * restores grants must fully supersede whatever an earlier, narrower call
 * already put there (a capability the manifest passed here no longer
 * declares must not survive), never merely add to it. Harmless when
 * `grants` is already empty -- clears nothing, then populates as normal.
 *
 * REUSES an existing live grant's id, rather than the fresh one
 * `hydrateGrants` minted for it, when that capability's restored patterns
 * are set-equal (`sameOwnPatterns`) to what `grants` already held for it
 * (A168). Two hydration passes over an unchanged manifest are the common
 * case -- `hydrateFromPinnedManifest` followed by the first real
 * `registerApp` for the same bundle -- and without this, that pair alone
 * mints a NEW GrantId for authority that never actually changed. A handle
 * already acquired under the OLD id (`HandleTable.byGrant`,
 * ../handles/handle-store.ts) is frozen at acquire time and never rebinds,
 * so the id churn alone would leave `revoke`/`revokePersisted` unable to
 * find it ever again -- the revoke button would lie. This is the same
 * principle `src/main/grant-changed-capabilities.ts` already applies one
 * layer up, for the same reason (its own doc comment).
 *
 * Every OTHER capability `grants` held before this call -- dropped outright,
 * or replaced with patterns that are NOT set-equal -- is reported back as a
 * `SupersededGrant`, because reusing state ends there: unlike an id, a live
 * handle's actual authority cannot be silently swapped out from under it.
 * The caller (`GrantLedger`'s own callers, ultimately `createBroker` in
 * ../index.ts) is responsible for tearing those down.
 */
export function replaceHydratedGrants (
  storage: LedgerStorage,
  origin: string,
  manifest: Manifest,
  grants: Map<CapabilityKind, Grant>,
  newId: () => GrantId
): readonly SupersededGrant[] {
  const restored = new Map(hydrateGrants(storage, origin, manifest, newId))
  const superseded: SupersededGrant[] = []

  for (const [capability, existing] of grants) {
    const next = restored.get(capability)
    if (next !== undefined && sameOwnPatterns(next.patterns, existing.patterns)) {
      restored.set(capability, existing) // unchanged authority -- keep the OLD id
    } else {
      superseded.push({ capability, grantId: existing.id })
    }
  }

  grants.clear()
  for (const [capability, grant] of restored) grants.set(capability, grant)
  return superseded
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
export function persistGrants (
  storage: LedgerStorage | undefined,
  origin: string,
  grants: ReadonlyMap<CapabilityKind, Grant>,
  appName?: string
): void {
  if (storage === undefined || !isPersistableOrigin(origin)) return
  storage.writeGrants(origin, grantsToPersist(grants), appName)
}
