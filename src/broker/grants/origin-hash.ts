// A stable, collision-resistant identifier derived from an origin -- shared
// by nodeFs.rootFor (node-adapters.ts, the fs confinement root) and by the
// session names below (the Electron session partition, which keeps the first
// PARTITION_HASH_LENGTH digits), the same way T13b already requires for
// `apps/`: a directory or partition NAMED with the literal origin string
// collapses `https://Example.com` and `https://example.com` on a
// case-insensitive filesystem. Every use is a one-way door under the SAME
// trigger -- ADR-0003's "before the first grant is persisted" -- so one
// frozen construction, in one file, is what keeps that warning from
// drifting into several.
//
// NOT IN src/broker/policy/: the two hashing modules there (derive.ts,
// bundle-hash.ts) use globalThis.crypto.subtle, async-only, so that layer
// outlives the engine underneath it (ADR-0002). BrokerFs.rootFor and
// session.fromPartition are both synchronous, and node:crypto's sync
// createHash is the only fit (CLAUDE.md Rule 6). A hash construction is an
// encoding, not a security decision, so it belongs beside its two callers
// in src/broker/, alongside token-bucket.ts and port-registry.ts.
//
// PRECONDITION, ENFORCED ONLY AT THE CALL SITE: `canonicalOrigin` must
// already be canonical. No function here canonicalizes, and none
// ever will -- originFromUrl (policy/origin.ts) is the one definition of
// canonical, and index.ts's canonical() is the one enforcement point.
// Passing a raw, un-canonicalized URL produces a wrong-but-plausible
// directory name and partition that nothing here detects.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** `sha256_hex(utf8(canonicalOrigin))`. No salt, no prefix, no version tag -- a one-way door once any app has data on a real machine. */
export function originHash (canonicalOrigin: string): string {
  return createHash('sha256').update(canonicalOrigin, 'utf8').digest('hex')
}

/**
 * T13b's separate root for an app's OWN files (`fs` capability writes),
 * SIBLING to `apps/<hash>` rather than nested under it: the loader's
 * own state, `apps/<hash>/{code,pin.json,...}`, and an app's own data must
 * never share a root, or a pin re-verify and an app's declared quota would
 * be governing one tree instead of two disjoint ones. `node-fs-adapter.ts`'s
 * `nodeFs` and `site-data-runner.ts`'s storage snapshot both need exactly
 * this path -- one join, not two `'app-data'` string literals drifting.
 */
export function appDataRoot (userDataPath: string, canonicalOrigin: string): string {
  return join(userDataPath, 'app-data', originHash(canonicalOrigin))
}

/**
 * How many hex digits of `originHash` a session's folder name keeps. Chromium puts a service worker's cache index
 * about 130 characters below `Partitions/<kind>-<hash>/`, and Windows refuses a path over 259 characters, so with
 * 32 digits the profile folder may be 80 characters long for an app's session (78 for the others) and only 48
 * with 64. 32 digits are 128 bits: no two origins that exist share a name, and nobody can search for a second
 * origin with a given name.
 */
export const PARTITION_HASH_LENGTH = 32

/** The kinds of persistent session named from an origin's hash, each the folder `Partitions/<kind>-<partitionHash>`; `launch/partition-folders.ts` moves the folders an earlier name left. */
export const HASHED_PARTITION_KINDS = ['app', 'embed', 'local'] as const
export type HashedPartitionKind = (typeof HASHED_PARTITION_KINDS)[number]

/** The first `PARTITION_HASH_LENGTH` digits of `originHash`: what a session's folder name is made of. */
export function partitionHash (key: string): string {
  return originHash(key).slice(0, PARTITION_HASH_LENGTH)
}

// `persist:`, not a bare name: a bare Electron partition lives in memory and is cleared on quit, which would wipe
// the localStorage, IndexedDB, cookies and cache ADR-0003 keeps in it. The kind prefix keeps one namespace per
// consumer of session.fromPartition, and the name self-describing on disk.
/** What every session name of `kind` starts with. */
export function partitionPrefix (kind: HashedPartitionKind): string {
  return `persist:${kind}-`
}

/** The Electron `session.fromPartition(...)` argument for the session of `kind` that `key` (an origin, or a local file's key) owns. */
export function hashedPartitionName (kind: HashedPartitionKind, key: string): string {
  return `${partitionPrefix(kind)}${partitionHash(key)}`
}

// NOT ADDRESSED HERE: T13c forbids persisting *grants* for loopback and plain-http origins. The same reasoning
// arguably extends to web storage -- a dev `http://localhost:3000` partition is inherited by whatever unrelated
// server occupies that port next -- but this function ships uniform `persist:` for every origin. Raised, not resolved.
/** An Electron `session.fromPartition(...)` argument for this origin's app. */
export function partitionFor (canonicalOrigin: string): string {
  return hashedPartitionName('app', canonicalOrigin)
}
