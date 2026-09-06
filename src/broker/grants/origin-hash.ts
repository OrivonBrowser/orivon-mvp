// A stable, collision-resistant identifier derived from an origin -- shared
// by nodeFs.rootFor (node-adapters.ts, the fs confinement root) and
// partitionFor below (the Electron session partition), the same way T13b
// already requires for `apps/`: a directory or partition NAMED with the
// literal origin string collapses `https://Example.com` and
// `https://example.com` on a case-insensitive filesystem. Both callers are
// one-way doors under the SAME trigger -- ADR-0003's "before the first
// grant is persisted" -- so one frozen construction, in one file, is what
// keeps that warning from drifting into two.
//
// NOT IN src/broker/policy/, on purpose. The two existing hashing modules
// there (derive.ts, bundle-hash.ts) both use globalThis.crypto.subtle --
// async-only, so that layer outlives the engine underneath it (ADR-0002).
// BrokerFs.rootFor and session.fromPartition are both synchronous, and
// node:crypto's sync createHash is the only fit for that -- CLAUDE.md Rule
// 6 (prefer mature components) rules out hand-rolling SHA-256 instead. A
// hash construction is an encoding, not a security decision, so it belongs
// beside its two callers in src/broker/, the same place token-bucket.ts and
// port-registry.ts (also pure, also not a policy/ decision) already live.
//
// PRECONDITION, ENFORCED ONLY AT THE CALL SITE: `canonicalOrigin` must
// already be canonical. Neither function here canonicalizes, and neither
// ever will -- originFromUrl (policy/origin.ts) is the one definition of
// canonical, and index.ts's canonical() is the one enforcement point.
// Passing a raw, un-canonicalized URL produces a wrong-but-plausible
// directory name and partition that nothing here detects.

import { createHash } from 'node:crypto'

/** `sha256_hex(utf8(canonicalOrigin))`. No salt, no prefix, no version tag -- a one-way door once any app has data on a real machine. */
export function originHash (canonicalOrigin: string): string {
  return createHash('sha256').update(canonicalOrigin, 'utf8').digest('hex')
}

// AI RECOMMENDATION, NOT AN OWNER DECISION -- flagged here and in the PR
// body, not silently chosen. No document specifies the partition string's
// format at all (grep confirms zero occurrences of "persist:" anywhere in
// this repo before this file).
//
// `persist:`, not a bare partition name: ADR-0003 puts localStorage,
// IndexedDB, cookies and cache in this partition and is titled "local-first
// storage" -- a bare (in-memory) Electron partition is cleared on quit,
// which would wipe all of that every restart and contradict the ADR's
// central claim.
//
// `app-` prefix: the partition namespace is flat and shared with anything
// else that ever calls session.fromPartition(...). The prefix reserves this
// namespace and keeps the on-disk path self-describing before a second
// consumer exists.
//
// Full 64 hex, not truncated: matches rootFor and A22's recorded assumption
// that app root directory names are single-case hex. Risk flagged, not
// solved: `<userData>/Partitions/app-<64 hex>/Service Worker/CacheStorage/…`
// plus Chromium's own nested paths underneath could approach Windows'
// MAX_PATH. Truncating to 32 hex is the escape hatch if that bites -- but
// it is a one-way door the moment any partition exists on a real machine,
// so it must be decided before that, not after.
//
// NOT ADDRESSED HERE: T13c forbids persisting *grants* for loopback and
// plain-http origins. The same reasoning arguably extends to web storage --
// a dev `http://localhost:3000` partition is inherited by whatever
// unrelated server occupies that port next -- but this function ships
// uniform `persist:` for every origin. Raised, not resolved, in the PR body.
const PARTITION_PREFIX = 'persist:app-'

/** An Electron `session.fromPartition(...)` argument for this origin's app. */
export function partitionFor (canonicalOrigin: string): string {
  return `${PARTITION_PREFIX}${originHash(canonicalOrigin)}`
}
