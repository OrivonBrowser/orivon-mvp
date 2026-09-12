// T19's version-replay protection and d-0017's downgrade acknowledgement --
// the "has this app served us an older build than we already trusted" half of
// what GrantLedger used to hold. Split out under code-guidelines.md Rule 2
// when that class reached 496 of 500 lines, along the seam the owner chose:
// deciding whether an app may be UPDATED is a different job from recording
// what an app is ALLOWED TO DO, and only the latter answers a capability call.
//
// Pure functions over the caller's own record, the same shape
// grant-persistence.ts already uses -- GrantLedger keeps the records and the
// public surface, this file keeps the rules.

import { isPersistableOrigin } from '../policy/origin.js'
import { compareVersions } from '../policy/update.js'
import type { LedgerStorage } from './ledger-storage.js'

/** The two fields of an origin's record this module reads and writes. `GrantLedger`'s own `OriginRecord` satisfies it structurally. */
export interface UpdateSafetyRecord {
  versionFloor: string
  rollbackAcknowledgedVersion: string | undefined
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
export function hydrateFloor (storage: LedgerStorage | undefined, origin: string, record: UpdateSafetyRecord): void {
  if (storage === undefined || !isPersistableOrigin(origin)) return
  const persisted = storage.readVersionFloor(origin)
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
export function hydrateRollbackAcknowledgedVersion (storage: LedgerStorage | undefined, origin: string, record: UpdateSafetyRecord): void {
  if (storage === undefined || !isPersistableOrigin(origin)) return
  const persisted = storage.readAcknowledgedRollbackVersion(origin)
  if (persisted !== undefined) record.rollbackAcknowledgedVersion = persisted
}

/**
 * d-0017: records that the user accepted a specific below-floor version. NOT
 * a boolean -- see `GrantLedger.rollbackAcknowledgedVersionFor`. In memory
 * first, then disk, mirroring `raiseFloor`'s ordering for the same reason.
 */
export function acknowledgeRollback (
  storage: LedgerStorage | undefined, origin: string, record: UpdateSafetyRecord, version: string
): void {
  record.rollbackAcknowledgedVersion = version
  if (storage !== undefined && isPersistableOrigin(origin)) {
    storage.writeAcknowledgedRollbackVersion(origin, version)
  }
}

/**
 * T19's raise-only rule, the one writer of a raised floor. THE IN-MEMORY
 * RAISE HAPPENS FIRST AND IS UNCONDITIONAL -- nothing about persistence may
 * delay or skip it, or a failed write leaves this session accepting a replay
 * of the superseded version. Returns whether the floor actually moved, so the
 * caller knows whether anything needs persisting alongside it.
 *
 * THROWS if the write fails, after the raise has already landed -- reported
 * rather than silent. README.md's design notes carry the reasoning.
 */
export function raiseFloor (
  storage: LedgerStorage | undefined, origin: string, record: UpdateSafetyRecord, version: string
): boolean {
  if (compareVersions(version, record.versionFloor) !== 1) return false
  record.versionFloor = version
  if (storage !== undefined && isPersistableOrigin(origin)) {
    storage.writeVersionFloor(origin, version)
  }
  return true
}
