// Where GrantLedger's own state that must survive a process restart gets
// persisted -- currently just the T19 version floor (docs/open-questions.md
// A57). Broker-owned, the same way src/loader/storage.ts's LoaderStorage is
// loader-owned: src/broker/ and src/loader/ each persist their own state
// under a separate root in userData (this file's real implementation uses
// `grants/`, never the loader's `apps/`), so whichever subsystem eventually
// deletes an app's data on removal only ever has to reason about its own
// tree, and never needs to know the other subsystem's on-disk layout.
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
}
