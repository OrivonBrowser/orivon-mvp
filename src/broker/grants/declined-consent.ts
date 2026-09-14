// A145's persisted "we asked, and the answer was no" marker -- the
// counterpart to update-safety.ts's floor/rollback-ack pair, but for
// install-consent.ts's whole-manifest decline rather than a version. Split
// out of grant-ledger.ts (code-guidelines.md Rule 2), same shape as
// update-safety.ts: pure functions over the caller's own record.
//
// EAGER HYDRATION, THE FLOOR'S SHAPE NOT THE GRANTS' (A158). A declined set
// is inert data -- it authorises nothing, and the comparison that consults
// it (requestInstallConsent, ../../main/install-consent.ts) always has a
// freshly fetched manifest of its own to compare against. So unlike
// GrantLedger's grants (grant-persistence.ts), which must wait for
// registerApp to supply a manifest to re-validate against, this hydrates
// the moment a record is first touched -- unconditionally, like
// versionFloor and rollbackAcknowledgedVersion. Deferring it to registerApp
// the way grants defers would only recreate A158's exact ordering hazard
// for a value that has no reason to share it.

import { isPersistableOrigin } from '../policy/origin.js'
import { isCapabilityKind } from '../policy/request-grant.js'
import type { CapabilityKind } from '../../contracts/index.js'
import type { LedgerStorage } from './ledger-storage.js'

/** The one field this module reads and writes. `GrantLedger`'s own `OriginRecord` satisfies it structurally. */
export interface DeclinedConsentRecord {
  declinedCapabilities: readonly CapabilityKind[] | undefined
}

/**
 * Loads `origin`'s persisted decline into a freshly created record -- called
 * from `#record`'s create branch, the same call site `hydrateFloor` uses and
 * for the same reason (see this file's header).
 *
 * UNTRUSTED CONTENT, FILTERED: `LedgerStorage.readDeclinedCapabilities`
 * returns plain strings, not yet known to be real `CapabilityKind` literals
 * -- a hand-edited or corrupted file could name anything. An entry that
 * fails `isCapabilityKind` is dropped rather than rejecting the whole
 * record: it simply cannot suppress a prompt for that (unrecognised)
 * capability, which is the safe direction.
 */
export function hydrateDeclinedCapabilities (storage: LedgerStorage | undefined, origin: string, record: DeclinedConsentRecord): void {
  if (storage === undefined || !isPersistableOrigin(origin)) return
  const persisted = storage.readDeclinedCapabilities(origin)
  if (persisted === undefined) return
  const filtered = persisted.filter(isCapabilityKind)
  if (filtered.length > 0) record.declinedCapabilities = filtered
}

/**
 * Records `capabilities` as the set `origin`'s install-consent dialog was
 * just declined for -- in memory first, unconditionally, then persisted
 * best-effort. A FAILED WRITE IS LOGGED, NEVER THROWN, unlike
 * `raiseFloor`'s write: this value is advisory only (A145) -- it can never
 * become or imply a grant, so the worst a lost write costs is one avoidable
 * re-prompt on the next restart, never a security regression.
 */
export function recordDeclinedConsent (storage: LedgerStorage | undefined, origin: string, record: DeclinedConsentRecord, capabilities: readonly CapabilityKind[]): void {
  record.declinedCapabilities = capabilities
  if (storage === undefined || !isPersistableOrigin(origin)) return
  try {
    storage.writeDeclinedCapabilities(origin, capabilities)
  } catch (error) {
    console.error('[broker] a declined install-consent decision could not be persisted; it will be asked again next restart', origin, error)
  }
}

/**
 * Clears whatever `origin`'s decline record holds -- called once a later
 * visit's dialog is ACCEPTED, so an old "no" cannot outlive a "yes" for the
 * same-or-narrower question (this file's header). Same best-effort failure
 * handling as `recordDeclinedConsent`.
 *
 * NOT what `GrantLedger.forgetOrigin` uses for this piece of state: that
 * method's own disk-then-memory contract requires a failed delete to leave
 * the in-memory record untouched, which this function's best-effort
 * swallow-and-log would break. `forgetOrigin` calls `storage.
 * deleteDeclinedCapabilities` directly instead, inside its own try block,
 * alongside the floor/rollback-ack/grants deletes.
 */
export function clearDeclinedConsent (storage: LedgerStorage | undefined, origin: string, record: DeclinedConsentRecord): void {
  record.declinedCapabilities = undefined
  if (storage === undefined || !isPersistableOrigin(origin)) return
  try {
    storage.deleteDeclinedCapabilities(origin)
  } catch (error) {
    console.error('[broker] a declined install-consent record could not be cleared on disk; it may still be remembered after a restart even though it was just accepted', origin, error)
  }
}
