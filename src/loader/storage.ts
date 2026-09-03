// The loader's cache: what persists a fetched, validated bundle and its pin
// record. src/loader/README.md permits depending on src/broker/ for storage;
// src/broker/grant-ledger.ts (in-memory only, no disk I/O anywhere) and
// src/broker/index.ts's CreateBrokerOptions (dial/resolve/now/fs/keychain --
// no pin- or manifest-cache member) were both checked, and neither has
// anything to call. So this interface is defined here, loader-side, the same
// way this lane's brief explicitly permits.
//
// NO REAL (node:fs-backed) IMPLEMENTATION SHIPS IN THIS LANE. That is a
// deliberate scope line, not an oversight -- see this PR's body under
// "Deliberately not done". Building one safely means reusing
// src/broker/policy/paths.ts's confinePath for the same reason nodeFs
// (src/broker/node-adapters.ts) does, and that is broker-shaped work the
// brief explicitly defers ("note in the PR that broker work is still needed
// to back it for real").
//
// KEYED ON THE CANONICAL ORIGIN, not a directory name -- matching
// PinRecord.origin (pin.ts) and BrokerFs.rootFor's own shape
// (src/broker/index.ts). A real backing implementation computes whatever
// on-disk layout it needs from that origin internally, the same way
// node-adapters.ts's nodeFs hides originHash(origin) behind rootFor(origin)
// rather than exposing it to callers.

import type { PinRecord } from '../broker/policy/pin.js'

export interface LoaderStorage {
  /**
   * The raw value previously passed to writePin for this origin, or
   * undefined if this origin has never been pinned. NEVER THROWS -- same
   * discipline pin.ts's own parsePinRecord takes: a storage backend that
   * cannot read (missing file, corrupt bytes) returns undefined, exactly
   * like "never pinned", so the caller's own parsePinRecord/TOFU branch
   * decides what that means rather than an exception unwinding through a
   * security decision.
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
}

/**
 * The app's on-disk root directory name (A22, security-model.md T13b):
 * `sha256(canonical_origin)`, lowercase hex, single-case -- load-bearing for
 * policy/paths.ts's case-SENSITIVE confinement comparison. Re-exported from
 * src/broker/origin-hash.ts's `originHash` rather than a second
 * implementation (code-guidelines.md Rule 3) -- that file's own header
 * explains why the construction lives beside its other caller
 * (`partitionFor`) rather than in policy/, and it is the one definition A22
 * requires every future consumer share.
 *
 * This lane is the first CALLER of it for the code-cache/pin-storage
 * purpose (A22's "build step 4 ... writes the first root directory") --
 * proven by storage.test.ts against an independent sha256 computation, not
 * merely assumed correct because the import compiles. What does not exist
 * yet is a real filesystem writing bytes under a directory of this name --
 * see this file's header.
 */
export { originHash as appRootDirectoryName } from '../broker/origin-hash.js'
