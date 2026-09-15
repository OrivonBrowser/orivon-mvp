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

/**
 * One `orivon.fs.userSelected` pick, persisted (D-0007). NO `id`: the
 * caller addresses one by the key it is stored under, the same convention
 * `PersistedGrant` follows for capability kind.
 *
 * `path` is the REAL, un-confined host path the OS picker returned -- the
 * one place outside the broker's own process this ever appears in plain
 * text, because the settings permissions list exists to let a person read
 * exactly what they gave access to. An app itself never sees it
 * (`DirectoryHandle`/`FileHandle` are opaque, handle-contracts.md).
 */
export interface PersistedPick {
  readonly kind: 'file' | 'directory'
  readonly path: string
  readonly pickedAt: number
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
   *
   * `appName` is the app's own declared name, for the settings list to show
   * when that app has not been opened this session. Omitted by callers that
   * have no manifest to hand -- notably `revoke` -- and an implementation
   * MUST then preserve whatever name it already holds, or revoking one
   * capability would erase the app's name from the list.
   */
  writeGrants(origin: string, grants: Readonly<Record<string, PersistedGrant>>, appName?: string): void
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

  /**
   * Everything the settings permissions list needs about ONE origin, read
   * straight off disk, for an app that has not been opened this session
   * (C-01/C-02, A137).
   *
   * DISPLAY ONLY, AND THE RETURN TYPE IS WHAT ENFORCES THAT. It hands back the
   * app's NAME AS A STRING, never a `Manifest` -- so there is nothing here a
   * caller could pass to `decideGrantRequest`, and the display path physically
   * cannot become an authority path. That is not stylistic: the first attempt
   * at this feature persisted a whole manifest and validated restored grants
   * against it, which meant both halves of the check came off disk and anyone
   * who could write into the userData directory could mint a consistent pair
   * and grant themselves anything (A137). `policy/pin.ts` states the rule this
   * broke -- a value read off disk must not be trusted more than the same
   * value arriving fresh.
   *
   * The patterns come back as the raw strings that were persisted, for
   * rendering. Nothing may authorise a connection from them: a live capability
   * call still gates on the in-memory ledger, which is populated only by
   * `registerApp` with a freshly fetched manifest.
   *
   * `undefined` when this origin has nothing persisted, and for a record that
   * cannot be read or parsed -- a missing row in a list, never authority.
   */
  readPersistedApp(origin: string): PersistedApp | undefined

  /**
   * The capability set `origin`'s install-consent dialog (`../../main/
   * install-consent.ts`) was most recently DECLINED for (A145), as plain
   * untrusted strings -- not yet known to be real `CapabilityKind` literals.
   * `undefined` for an origin never declined, for one whose decline was
   * later cleared by an accepted visit, AND for a record that cannot be
   * read or parsed. Collapsing a corrupt read to "nothing remembered" is
   * the safe direction here, the same reasoning
   * `readAcknowledgedRollbackVersion`'s own doc gives: this value is never
   * consulted by anything that grants, so the worst a corrupt or lost read
   * costs is one avoidable re-prompt, never authority.
   */
  readDeclinedCapabilities(origin: string): readonly string[] | undefined
  /** Persists `capabilities` as the set declined for `origin`, replacing whatever was there before -- one decision in force per origin at a time, same shape as `writeAcknowledgedRollbackVersion`. */
  writeDeclinedCapabilities(origin: string, capabilities: readonly string[]): void
  /**
   * Deletes whatever declined-capability record was persisted for `origin`,
   * if any -- called both when a later visit ACCEPTS install consent (the
   * remembered "no" no longer applies) and from `GrantLedger.forgetOrigin`.
   * A no-op, never a throw, for an origin nothing was ever persisted for.
   */
  deleteDeclinedCapabilities(origin: string): void

  /**
   * Every `orivon.fs.userSelected` pick persisted for `origin`, keyed by a
   * caller-minted pick id (the SAME string `PickedPathLedger` uses as the
   * handle table's `pickId` when a pick is live this session --
   * `../handles/handle-contracts.js`'s `Authorisation`). `undefined` for an
   * origin never persisted, and for a record that cannot be read or parsed
   * -- same fail-safe direction as `readGrants`'s own doc: a pick that fails
   * to restore only costs it missing from the settings list, never
   * authority nobody has.
   *
   * SHARES `origin`'s ONE FILE WITH `readGrants`/`writeGrants` -- D-0007's
   * own text: "P4-3 and P4-4 now share a surface." `writeGrants` and
   * `writePickedPaths` each preserve whatever slice of that file the other
   * one owns; see `nodeLedgerStorage`'s implementation for how.
   */
  readPickedPaths(origin: string): Readonly<Record<string, PersistedPick>> | undefined
  /**
   * Persists the FULL set of `origin`'s current picks, replacing whatever
   * was there before -- same one-file-written-whole shape as `writeGrants`,
   * and `appName` means the same thing here it does there.
   */
  writePickedPaths(origin: string, picks: Readonly<Record<string, PersistedPick>>, appName?: string): void
  /**
   * Deletes whatever picks were persisted for `origin`, if any -- the
   * picked-path half of a full forget (`GrantLedger.forgetOrigin`), and a
   * no-op, never a throw, for an origin nothing was ever persisted for.
   * Leaves `origin`'s grants (and file) untouched when any remain -- see
   * `nodeLedgerStorage`'s implementation.
   */
  deletePickedPaths(origin: string): void
}

/** One app as the settings list sees it before that app has ever been opened. See `LedgerStorage.readPersistedApp`. */
export interface PersistedApp {
  readonly origin: string
  /** The app's own declared name, as of the last time it was registered. A
   * string and nothing more -- see `readPersistedApp` for why this is not a
   * `Manifest`. Absent if the record predates this field. */
  readonly appName: string | undefined
  readonly grants: Readonly<Record<string, PersistedGrant>>
  /** This app's persisted `userSelected` picks, keyed the same way `readPickedPaths` returns them. Empty, never absent, for a record that predates this field or simply has none. */
  readonly pickedPaths: Readonly<Record<string, PersistedPick>>
}
