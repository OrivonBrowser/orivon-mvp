// Where GrantLedger's own state that must survive a process restart gets
// persisted -- the T19 version floor (A57), d-0017's rollback acknowledgement,
// and now the grants themselves (A23). Broker-owned, the same way
// src/loader/storage.ts's LoaderStorage is loader-owned: this file's real
// implementation puts all of it under its own `grants/` root, never the
// loader's `apps/` (node-adapters.ts's `nodeFs` is the one exception, writing
// under `apps/<hash>/files` -- predates this file, see README.md).
//
// SYNCHRONOUS, not Promise-based like LoaderStorage -- deliberately.
// GrantLedger's own registerApp/versionFloorFor are relied on throughout
// this codebase's own tests as effectively synchronous: dozens of call sites
// invoke Broker.registerApp without awaiting its Promise<void>, which only
// ever worked because nothing inside it actually yielded. Making persistence
// genuinely async would turn every one of those into a real race -- a
// correctness regression, not just a test-fixup exercise. See README.md for
// the full reasoning.

import type { Pattern } from '../../contracts/index.js'

/**
 * One capability's persisted authority. NO `id` and NO `origin`: hydration
 * (`grant-persistence.ts`) always mints a fresh GrantId (`GrantLedger.grant`'s
 * own rule -- an id is never derived from a grant's content) and already
 * knows which origin's file it read, so neither belongs in what disk holds.
 */
export interface PersistedGrant {
  readonly patterns: readonly Pattern[]
  readonly grantedAt: number
}

export interface LedgerStorage {
  /**
   * The persisted version floor for `origin`, or undefined ONLY if this
   * origin has genuinely never had one persisted (no file). A file that
   * exists but cannot be read or parsed must NOT also return undefined --
   * that would be indistinguishable from "never installed" to GrantLedger,
   * silently resetting T19's protection to its weakest state. Return
   * whatever malformed text was found (or any string) instead: GrantLedger
   * detects "not orderable semver" itself and fails closed, the same
   * "ambiguous input must not look like the safe case" discipline
   * LoaderStorage.readPin already applies to a corrupt pin file.
   */
  readVersionFloor(origin: string): string | undefined
  /** Persists the new version floor for `origin`. Overwrites whatever was there before. */
  writeVersionFloor(origin: string, versionFloor: string): void
  /**
   * Deletes whatever version floor was persisted for `origin`, if any --
   * A60's escape hatch (`GrantLedger.forgetOrigin`). A no-op, never a throw,
   * for an origin nothing was ever persisted for.
   */
  deleteVersionFloor(origin: string): void

  /**
   * The SPECIFIC below-floor version `origin`'s rollback was last
   * acknowledged for (owner decision d-0017: T19 warns and lets the user
   * accept a below-floor version rather than only ever blocking it).
   * `undefined` for an origin never acknowledged, AND for a corrupt or
   * unreadable record. NOT A BOOLEAN -- see GrantLedger's own
   * `rollbackAcknowledgedVersion` field doc (grant-ledger.ts) for why.
   *
   * The fail-closed direction here is simpler than a boolean's would be: a
   * corrupt read collapsing to `undefined` is indistinguishable from "never
   * acknowledged" to every future comparison, which is exactly correct --
   * there is no valid version string a corrupt read could produce that
   * would coincidentally equal a real offered version and skip a prompt it
   * should not.
   */
  readAcknowledgedRollbackVersion(origin: string): string | undefined
  /** Persists `version` as the acknowledged rollback version for `origin`. Overwrites whatever was there before -- one acknowledgement in force per origin at a time, same shape as `writeVersionFloor`. */
  writeAcknowledgedRollbackVersion(origin: string, version: string): void
  /**
   * Deletes whatever acknowledged version was persisted for `origin`, if
   * any -- called alongside `deleteVersionFloor` from `GrantLedger.
   * forgetOrigin`, so removing an app's poisoned floor also removes its
   * acknowledgement rather than leaving a stale one for a floor that no
   * longer exists. A no-op, never a throw, for an origin nothing was ever
   * persisted for.
   */
  deleteAcknowledgedRollbackVersion(origin: string): void

  /**
   * Every grant persisted for `origin`, keyed by capability kind AS A PLAIN
   * STRING -- untrusted disk content, not yet known to be one of the seven
   * real `CapabilityKind` literals; the caller (`grant-persistence.ts`) is the
   * one that checks. `undefined` for an origin never persisted, AND for a
   * file that exists but cannot be parsed as the expected shape.
   *
   * UNLIKE `readVersionFloor`, collapsing a corrupt read to "nothing" is the
   * SAFE direction here, not the dangerous one: the floor's replay guard gets
   * WEAKER at its default ('0.0.0'), but a grant that fails to restore only
   * costs a re-prompt -- it can never mint authority nobody has, which is the
   * one thing this whole feature must never do. Same reasoning
   * `readAcknowledgedRollbackVersion`'s own doc gives for its `undefined`
   * collapse.
   */
  readGrants(origin: string): Readonly<Record<string, PersistedGrant>> | undefined
  /**
   * Persists the FULL set of `origin`'s current grants, replacing whatever
   * was there before -- one file, written whole, so a reader never observes
   * a set with one grant added but another not yet removed.
   */
  writeGrants(origin: string, grants: Readonly<Record<string, PersistedGrant>>): void
  /**
   * Deletes whatever grants were persisted for `origin`, if any -- called
   * from `GrantLedger.forgetOrigin` alongside the floor and acknowledgement
   * deletes, so a fully forgotten origin does not have its capabilities
   * reappear on the next restart. A no-op, never a throw, for an origin
   * nothing was ever persisted for.
   */
  deleteGrants(origin: string): void

  /**
   * Every origin that currently has grants persisted, in no particular
   * order -- what makes the settings permissions list survive a restart
   * (C-01/C-02, `docs/open-questions.md`). Before this existed, the on-disk
   * key was `sha256(origin)` and nothing anywhere could turn that back into
   * an origin, so `PermissionsController.list()` returned `[]` for every
   * grant made before the current session while the grant itself stayed
   * live and rehydrated the moment the app was reopened.
   *
   * AN ORIGIN HERE IS A CLAIM THE IMPLEMENTATION HAS ALREADY CHECKED, not
   * one the caller must re-check: whatever is on disk names its own origin,
   * so an implementation MUST verify that name against the location it was
   * read from and omit it otherwise (see `nodeLedgerStorage`). Listing an
   * origin still grants nothing -- `hydrateGrants` re-validates every
   * restored capability against that origin's CURRENT manifest -- but an
   * unverified name would let a tampered file put an origin the user never
   * installed into a list they revoke from, which is its own kind of lie.
   *
   * Returns an empty array, never a throw, when nothing has been persisted
   * or the store cannot be read at all.
   */
  listPersistedOrigins(): readonly string[]
}
