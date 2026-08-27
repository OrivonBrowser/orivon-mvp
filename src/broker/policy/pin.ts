// The pin record: what the broker persists once a bundle hash is accepted,
// and the fail-closed check over it. Pure functions, no I/O -- see
// ./README.md. The record's SHAPE and the membership rule are ADR-0009 /
// security-model.md T21; the file on disk is written and read one layer up
// (src/loader/, build step 4).
//
// WHY THIS IS SEPARATE FROM bundle-hash.ts: that file computes an identity
// from bytes the caller already has in hand. This file answers a different
// question -- "does this ALREADY-PINNED app's on-disk record still recognise
// this path?" -- against a record that arrived as JSON, off disk, and must be
// treated with the same suspicion as any other externally-supplied document
// (update.ts's patternsFor sets the precedent: Object.hasOwn plus an
// Array.isArray check on every field, because a crash inside a security
// decision is itself the failure).

import type { OrivonError, OrivonErrorCode } from '../../contracts/index.js'
import { isValidCanonicalPath, type PathLeaf } from './bundle-hash.js'
import { originFromUrl } from './origin.js'

/**
 * Already-canonical or rejected, never repaired -- the same stance
 * isValidCanonicalPath takes on paths, for the same reason. `origin` says
 * which app a pin belongs to and is matched against Grant.origin; a pin
 * spelled differently from the ledger's spelling of the same origin is a bug,
 * and normalising it here would hide it rather than surface it.
 *
 * Uses origin.ts's definition rather than a second one, including its
 * trailing-DNS-dot rule (open-questions A14). Two origin definitions in one
 * broker is exactly how a grant ends up keyed to something a pin cannot find.
 */
function isCanonicalOrigin (origin: string): boolean {
  return originFromUrl(origin) === origin
}

/** The only schema version that exists. Bumped, never mutated in place -- see PinRecord. */
export const PIN_SCHEMA_VERSION = 1

const BUNDLE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

function fail (code: OrivonErrorCode, message: string): OrivonError {
  return Object.assign(new Error(message), { code })
}

/** One entry in the pinned asset set. Same shape as bundle-hash.ts's PathLeaf. */
export type PinnedAsset = PathLeaf

/**
 * What the broker persists once a bundle is accepted (TOFU or a re-consented
 * update). Deliberately does NOT carry `versionFloor`: that value must
 * survive an uninstalled-then-reinstalled app (ADR-0009), and this record
 * does not -- uninstall deletes the pin and the code cache together. The
 * floor lives in the grant ledger / browser-secrets tier instead
 * (ADR-0003's four-tier table, which this record is a fifth thing next to).
 */
export interface PinRecord {
  /**
   * Bumped on any change to this shape, never mutated in place -- an
   * existing pin on disk must stay readable by a broker that has since moved
   * to a newer schema. Today there is only one value.
   */
  readonly schema: 1
  /** The web origin this pin belongs to. Matches Grant.origin's definition. */
  readonly origin: string
  /** The bundle hash this pin was computed for -- see ./bundle-hash.js. */
  readonly bundleHash: string
  /**
   * THE PINNED ASSET SET. Load-bearing, not bookkeeping: this is the only
   * thing that can answer security-model.md T21's fail-closed question ("is
   * this requested path one this bundle ever claimed?"). The root alone
   * cannot -- a root is a single opaque digest, not a membership index.
   */
  readonly assets: readonly PinnedAsset[]
  /** `Manifest.version` of the pinned bundle. */
  readonly version: string
  /** When this pin was written, epoch milliseconds. */
  readonly pinnedAt: number
}

/**
 * Parses a value read from disk into a PinRecord, or null if it does not
 * validate. NEVER THROWS -- a malformed pin file must deny gracefully
 * (nothing is pinned, so nothing runs from cache), not crash the broker.
 *
 * Every field is checked as an OWN property with the expected primitive
 * shape before being trusted, the same discipline update.ts's patternsFor
 * applies to a manifest: a `__proto__` key must not resolve through the
 * prototype chain to something that looks valid, and a wrong-shaped value
 * must not throw partway through validation.
 */
export function parsePinRecord (raw: unknown): PinRecord | null {
  if (typeof raw !== 'object' || raw === null) return null

  if (!ownNumber(raw, 'schema') || (raw as { schema: unknown }).schema !== PIN_SCHEMA_VERSION) {
    return null
  }

  const origin = ownString(raw, 'origin')
  if (origin === undefined || !isCanonicalOrigin(origin)) return null

  const bundleHash = ownString(raw, 'bundleHash')
  if (bundleHash === undefined || !BUNDLE_HASH_PATTERN.test(bundleHash)) return null

  const version = ownString(raw, 'version')
  if (version === undefined || version.length === 0) return null

  const pinnedAt = ownFiniteNumber(raw, 'pinnedAt')
  if (pinnedAt === undefined) return null

  const assets = parseAssets(raw)
  if (assets === null) return null

  return { schema: 1, origin, bundleHash, assets, version, pinnedAt }
}

function parseAssets (raw: object): readonly PinnedAsset[] | null {
  if (!Object.hasOwn(raw, 'assets')) return null
  const value = (raw as { assets: unknown }).assets
  if (!Array.isArray(value)) return null

  const assets: PinnedAsset[] = []
  const seenPaths = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const path = ownString(entry, 'path')
    const leaf = ownString(entry, 'leaf')
    // Held to bundle-hash.ts's definition, not merely "a non-empty string".
    // A record that reaches here did not necessarily come from bundleTree():
    // it came off disk. The pinned asset set is both T21's allowlist and the
    // map the code cache is laid out from, so a traversal segment or a NUL
    // byte surviving into it is a path the broker itself would then write.
    if (path === undefined || !isValidCanonicalPath(path)) return null
    if (leaf === undefined || !BUNDLE_HASH_PATTERN.test(leaf)) return null
    // A pin record with a duplicated path is malformed -- it cannot have come
    // from bundleTree(), which rejects duplicate/colliding paths before
    // producing a root at all.
    if (seenPaths.has(path)) return null
    seenPaths.add(path)
    assets.push({ path, leaf })
  }
  return assets
}

function ownString (value: object, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function ownNumber (value: object, key: string): boolean {
  if (!Object.hasOwn(value, key)) return false
  return typeof (value as Record<string, unknown>)[key] === 'number'
}

function ownFiniteNumber (value: object, key: string): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * THE FAIL-CLOSED CHECK (security-model.md T21). True only if `canonicalPath`
 * is EXACTLY one of the paths this pin claims -- an allowlist membership
 * test, nothing more.
 *
 * Deliberately does no normalisation of its own: no trailing-slash strip, no
 * case fold, no percent-decode. `canonicalPath` must already be the output of
 * bundle-hash.ts's `canonicalAssetPath` (or an equivalently-derived string),
 * exactly as it was when the bundle was hashed. A path that differs from
 * every pinned path by so much as one character -- trailing slash, case,
 * percent-encoding -- is NOT in the set and is denied. That is the fail-
 * closed rule ADR-0005's amendment names directly: "a same-origin request
 * whose path is not in the pinned set is denied, not fetched," which is what
 * stops "one unsigned `<script>` into a code-split chunk the pinned asset set
 * never covered."
 */
export function isPinnedPath (pin: PinRecord, canonicalPath: string): boolean {
  return pin.assets.some((asset) => asset.path === canonicalPath)
}

/** Fails 'invalid' rather than silently pinning nothing if the tree is empty. */
export function fromBundleTree (
  origin: string,
  bundleHash: string,
  assets: readonly PinnedAsset[],
  version: string,
  pinnedAt: number
): PinRecord {
  if (!isCanonicalOrigin(origin)) throw fail('invalid', `not a canonical origin: ${JSON.stringify(origin.slice(0, 120))}`)
  if (!BUNDLE_HASH_PATTERN.test(bundleHash)) throw fail('invalid', `not a bundle hash: ${bundleHash}`)
  if (assets.length === 0) throw fail('invalid', 'a pin record needs at least one pinned asset')
  if (version.length === 0) throw fail('invalid', 'a pin record needs a non-empty version')
  if (!Number.isFinite(pinnedAt)) throw fail('invalid', 'pinnedAt must be a finite number')

  // This constructor is exported, so it is reachable with an asset list that
  // did NOT come from bundleTree(). Every property the name promises is
  // therefore checked here rather than assumed -- otherwise the two ways of
  // building a record (this and parsePinRecord) hold different lines.
  const seenPaths = new Set<string>()
  for (const asset of assets) {
    if (!isValidCanonicalPath(asset.path)) {
      throw fail('invalid', `not a valid canonical path: ${JSON.stringify(asset.path.slice(0, 120))}`)
    }
    if (!BUNDLE_HASH_PATTERN.test(asset.leaf)) {
      throw fail('invalid', `not a leaf digest: ${JSON.stringify(asset.leaf.slice(0, 120))}`)
    }
    if (seenPaths.has(asset.path)) {
      throw fail('invalid', `duplicate pinned path: ${JSON.stringify(asset.path.slice(0, 120))}`)
    }
    seenPaths.add(asset.path)
  }

  return { schema: 1, origin, bundleHash, assets, version, pinnedAt }
}
