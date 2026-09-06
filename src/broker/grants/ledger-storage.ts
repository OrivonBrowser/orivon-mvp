// Where GrantLedger's own state that must survive a process restart gets
// persisted -- currently just the T19 version floor (docs/open-questions.md
// A57). Broker-owned, the same way src/loader/storage.ts's LoaderStorage is
// loader-owned: this file's real implementation puts the version floor
// under its own `grants/` root, never the loader's `apps/`.
//
// NOT A CLEAN SEPARATION EVERYWHERE, THOUGH: node-adapters.ts's `nodeFs`
// (the OTHER piece of broker state, the `fs` capability's confined bytes)
// already writes under `apps/<hash>/files`, inside the loader's own root --
// that predates this file and is unchanged by it. So "one root per
// subsystem" holds for the version floor specifically, not as a whole-tree
// guarantee; whoever eventually builds app removal has to know about both
// roots either way.
//
// SYNCHRONOUS, not Promise-based like LoaderStorage -- deliberately.
// GrantLedger's own registerApp/versionFloorFor are relied on throughout
// this codebase's own tests (src/broker/index.test.ts) as effectively
// synchronous: dozens of call sites invoke Broker.registerApp without
// awaiting its Promise<void>, which only ever worked because nothing inside
// it actually yielded. Making persistence genuinely async would turn every
// one of those into a real race (the next line could run before the write
// landed) -- a correctness regression, not just a test-fixup exercise. A
// tiny per-origin JSON file is exactly the class of operation node-storage.ts
// already chose sync fs APIs for (codeRoot's mkdirSync, resolveAssetPath's
// realpathSync), for the same reason.

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
   * unreadable record.
   *
   * NOT A BOOLEAN, on purpose -- an earlier version of this file stored a
   * bare "has this origin ever been acknowledged" flag, and a review caught
   * the escalation it opens: accepting one real, presumably-safe rollback
   * (say `1.2.0` -> `1.1.9`) would permanently mark the ORIGIN as
   * acknowledged, silently waving through any later, unrelated below-floor
   * version the same host chooses to serve (`0.0.1`, or anything else) with
   * no new prompt and no further consent. Storing the specific version the
   * user actually agreed to lets the caller (a future UI-wiring PR) compare
   * it against whatever below-floor version is being offered NOW, and
   * prompt fresh on anything but an exact match.
   *
   * The fail-closed direction is simpler than the boolean's was: a corrupt
   * read collapsing to `undefined` is indistinguishable from "never
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
}
