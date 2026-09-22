// The loader's cache: what persists a fetched, validated bundle and its pin
// record. src/loader/README.md permits depending on src/broker/ for storage;
// src/broker/grants/grant-ledger.ts (in-memory only, no disk I/O anywhere) and
// src/broker/index.ts's CreateBrokerOptions (dial/resolve/now/fs/keychain --
// no pin- or manifest-cache member) were both checked, and neither has
// anything to call. So this interface is defined here, loader-side.
//
// The real node:fs-backed implementation is ./node-storage.ts.
//
// KEYED ON THE CANONICAL ORIGIN, not a directory name -- matching
// PinRecord.origin (pin.ts) and BrokerFs.rootFor's own shape
// (src/broker/index.ts). A real backing implementation computes whatever
// on-disk layout it needs from that origin internally, the same way
// node-adapters.ts's nodeFs hides originHash(origin) behind rootFor(origin)
// rather than exposing it to callers.

import type { PinRecord } from '../broker/policy/pin.js'

/** A readable file: its byte length, and its bytes as a stream of chunks -- never the whole file in one buffer. */
export interface AssetStream {
  readonly byteLength: number
  readonly chunks: AsyncIterable<Uint8Array>
}

/** One file being written into an origin's staging area; `id` names it to `readStaged`/`commitStaged`. */
export interface StagingWriter {
  readonly id: string
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface LoaderStorage {
  /**
   * The raw value previously passed to writePin for this origin, or
   * undefined ONLY if this origin has genuinely never been pinned (a
   * missing file). NEVER THROWS -- same discipline pin.ts's own
   * parsePinRecord takes: a security decision must not unwind through an
   * exception. But a backend that FOUND a pin file and could not read or
   * parse it (corrupt bytes, a permissions error) must NOT also return
   * undefined -- that would be indistinguishable from "never pinned" to
   * the caller, which is wrong: index.ts's load() treats undefined as
   * fresh TOFU with zero reconsent check, and a once-pinned-then-corrupted
   * origin must instead be forced through parsePinRecord's own rejection
   * path (any non-undefined value that fails validation), landing on
   * index.ts's `pinnedHash = ''` fallback rather than skipping the check
   * entirely.
   */
  readPin(origin: string): Promise<unknown>
  /** Persists the pin record. Overwrites whatever was there before. */
  writePin(origin: string, record: PinRecord): Promise<void>
  /**
   * Persists one asset's raw fetched bytes. `path` is already a validated
   * canonical path (bundle-hash.md's rejection table has already run by the
   * time this is called) -- `/`-rooted, percent-encoded, structurally safe
   * to decode into a filename.
   */
  writeAsset(origin: string, path: string, content: Uint8Array): Promise<void>
  /**
   * Deletes every previously written asset for `origin` whose canonical path
   * is not in `keep` -- the cleanup half of an update (docs/open-questions.md
   * A58, gap 2): without this, a superseded bundle version's files
   * accumulate on disk forever, since nothing else in this interface can
   * remove what a previous write left. Called at start, by
   * `electron-serve.ts`'s `restorePinnedServing`, never by an install: a
   * page still running the previous bundle may need its files until then.
   *
   * A no-op for an origin with nothing on disk yet (a fresh install).
   */
  pruneAssets(origin: string, keep: readonly string[]): Promise<void>
  /**
   * Reads back one previously-written asset's raw bytes, or undefined if the
   * content cannot be verified to still be what `writeAsset` wrote -- a path
   * never written, a file removed since, or one that failed to read. NEVER
   * THROWS, same discipline as `readPin`, but a SIMPLER contract than that
   * one: `readPin` must distinguish "never pinned" from "pinned but
   * unreadable" because `index.ts`'s TOFU-vs-reconsent branch depends on
   * which happened. Nothing downstream needs that distinction here --
   * `serve-verify.ts`'s whole-tree check denies the entire bundle on ANY
   * unreadable asset regardless of why, so every failure mode collapses to
   * the same `undefined`.
   */
  readAsset(origin: string, path: string): Promise<Uint8Array | undefined>
  /**
   * Every origin this storage holds a STRUCTURALLY VALID pin record for --
   * ADR-0007's "cached tree is re-verified at every load" needs a starting
   * list of origins to verify and serve, independent of any network fetch,
   * so a previously-installed app keeps working after a restart with no
   * connectivity (README.md's "offline first-run keeps working for
   * pre-cached apps"). A record that fails `parsePinRecord`, or whose
   * `origin` field does not re-hash to the directory it was read from, is
   * excluded rather than guessed at -- the same defence a hand-edited or
   * copied record needs as any other self-describing file this codebase
   * trusts only after checking it names its own storage location.
   */
  listPinnedOrigins(): Promise<readonly string[]>
  /**
   * STAGING: where a bundle's bytes wait between being fetched and being
   * installed, so no asset is ever held whole in memory and nothing
   * `readAsset` serves changes before `commitStaged`. One staging area per
   * origin; `clearStaging` empties it (a no-op when there is none).
   */
  clearStaging(origin: string): Promise<void>
  /** Opens a new, empty staged file for `origin`. */
  openStaged(origin: string): Promise<StagingWriter>
  /** A closed staged file's bytes, or undefined if `id` names none. Never throws. */
  readStaged(origin: string, id: string): Promise<AssetStream | undefined>
  /**
   * Moves a staged file into place as the asset at canonical `path`, in one
   * atomic rename: a reader sees the old bytes or the new ones, never a
   * partial file, and a crash leaves one or the other.
   */
  commitStaged(origin: string, id: string, path: string): Promise<void>
  /** `readAsset`'s streaming form, same never-throws, undefined-on-anything contract. */
  readAssetStream(origin: string, path: string): Promise<AssetStream | undefined>
}

/**
 * The app's on-disk root directory name (A22, security-model.md T13b):
 * `sha256(canonical_origin)`, lowercase hex, single-case -- load-bearing for
 * policy/paths.ts's case-SENSITIVE confinement comparison. Re-exported from
 * src/broker/grants/origin-hash.ts's `originHash` rather than a second
 * implementation (code-guidelines.md Rule 3) -- that file's own header
 * explains why the construction lives beside its other caller
 * (`partitionFor`) rather than in policy/, and it is the one definition A22
 * requires every future consumer share.
 *
 * Verified against an independent sha256 computation in storage.test.ts,
 * not merely assumed correct because the import compiles.
 */
export { originHash as appRootDirectoryName } from '../broker/grants/origin-hash.js'
