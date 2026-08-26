// The bundle hash: an app's content identity. Pure function, no I/O -- see
// ./README.md. Full specification, reasoning and frozen vectors:
// docs/architecture/bundle-hash.md, docs/decisions/ADR-0009.
//
// THIS CONSTRUCTION IS A ONE-WAY DOOR (ADR-0009). Once the first pin is
// persisted, changing anything below invalidates every stored pin and orphans
// every attestation issued against the old root. A failing row in
// ./bundle-hash.test.ts's frozen vector table means THE CHANGE IS WRONG --
// read that file's header before touching anything here.
//
// WebCrypto, not node:crypto, for the same reason as ./derive.ts:
// `globalThis.crypto.subtle` is a global across browsers, Node and WASI, so
// this layer outlives the engine underneath it (ADR-0002).

import type { OrivonError, OrivonErrorCode } from '../../contracts/index.js'

/**
 * One leaf: an asset's canonical path (see canonicalAssetPath) and its raw,
 * unmodified fetched bytes. Includes the manifest -- it is a leaf like any
 * other asset, hashed at MANIFEST_PATH (ADR-0009: a score cannot be silently
 * inherited by a widened manifest under an unchanged hash).
 */
export interface BundleEntry {
  readonly path: string
  readonly content: Uint8Array
}

/**
 * The reserved canonical path every bundle must carry exactly one leaf at.
 * Fetched before first run (capability-api.md SSManifest).
 */
export const MANIFEST_PATH = '/.well-known/orivon.json'

/**
 * Version tag, carried the same way derive.ts's KDF_SALT carries
 * 'orivon-kdf-v1': a domain separator baked into the root, not a negotiable
 * field. A v2 construction changes this string and adds vectors beside the
 * existing ones -- it never edits them, because every pin already issued was
 * computed under v1.
 */
export const BUNDLE_HASH_VERSION = 'orivon-bundle-v1'

/**
 * crypto.subtle.digest cannot stream, so each asset is briefly whole in
 * memory while its leaf is computed. Fine at ADR-0005's stated 2-4 MB
 * frontend; torrent payloads live in files/, never in the pinned set.
 *
 * AI RECOMMENDATION, NOT AN OWNER DECISION (ADR-0009 SSConsequences) -- these
 * numbers are a starting point, not a confirmed limit. Revisit before this
 * ships in the loader.
 */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

/** Bounded so a hostile path cannot exhaust memory building rejection messages. */
const MAX_PATH_BYTES = 1024

const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/  // C0 and C1 control characters

function fail (code: OrivonErrorCode, message: string): OrivonError {
  // OrivonError is an interface, not a class -- src/contracts/ emits no
  // runtime code (contracts/errors.ts). The broker builds the concrete
  // object; callers only ever switch on `code`.
  return Object.assign(new Error(message), { code })
}

/**
 * URL to canonical asset path, or null if the URL cannot back a hashed leaf.
 *
 * Derived from the URL, NEVER from a local filesystem path -- filesystem
 * paths differ by separator on Windows and case-fold on macOS/APFS, both
 * supported run-from-source targets (the same bug class T13b already had to
 * solve for origin -> directory names).
 *
 * Percent-encoding is preserved, not decoded: `/a%2Fb` and `/a/b` stay
 * distinct canonical paths, which is what keeps the hashed string
 * byte-identical to what a request line actually carries -- the property the
 * fail-closed pinned-asset check (security-model.md T21) depends on.
 */
export function canonicalAssetPath (assetUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(assetUrl)
  } catch {
    return null
  }

  return isValidCanonicalPath(parsed.pathname) ? parsed.pathname : null
}

/**
 * Structural validity of a canonical path, independent of how it was
 * produced. bundleHash() re-checks every entry's path against this rather
 * than trusting the caller ran it through canonicalAssetPath -- the same
 * "checked here, not trusted from the caller" stance derive.ts takes with
 * MIN_SEED_BYTES.
 */
function isValidCanonicalPath (path: string): boolean {
  if (path.length === 0 || !path.startsWith('/')) return false
  if (CONTROL_CHARS.test(path)) return false
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) return false

  // Any '.' or '..' segment surviving URL normalisation is rejected rather
  // than resolved -- this function REJECTS, it never repairs.
  const segments = path.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) return false

  return true
}

/**
 * NFC-normalise then simple-case-fold, for detecting whether two DISTINCT
 * canonical paths would collide on a case-insensitive or Unicode-normalising
 * filesystem (macOS/APFS, Windows). NEVER used inside the hash itself -- only
 * to decide whether the bundle must be rejected before hashing.
 *
 * Approximation, stated plainly: `.toLowerCase()` performs the closest thing
 * the JS standard library offers to Unicode simple case folding, but it is
 * not the full Unicode Default Case Folding table (which differs from
 * locale-independent lowercasing for a handful of characters, e.g. the
 * German sharp s under some folding modes). Good enough to catch the
 * overwhelmingly common ASCII case-collision, which is the actual failure
 * this function exists to prevent; not a formal guarantee for every
 * codepoint.
 */
function collisionKey (path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/**
 * Ascending unsigned UTF-8 byte order. Deliberately NOT
 * `Array.prototype.sort()`'s default, which compares UTF-16 code units and
 * disagrees with UTF-8 byte order for any character above U+FFFF -- a
 * supplementary-plane character's UTF-16 surrogate pair (0xD800-0xDFFF)
 * sorts BELOW U+E000-U+FFFF in code-unit order but its UTF-8 encoding
 * (0xF0-0xF4) sorts ABOVE U+E000-U+FFFF's UTF-8 encoding (0xEE-0xEF).
 * Invisible until an asset filename uses an emoji or CJK Extension
 * character; then two otherwise-correct implementations -- this one and a
 * provider's, in a different language -- disagree about a bundle's identity
 * permanently.
 */
function compareUtf8Bytes (a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

function encodeField (value: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + value.length)
  new DataView(out.buffer).setUint32(0, value.length, false)
  out.set(value, 4)
  return out
}

function encodeContentLength (byteLength: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(byteLength), false)
  return out
}

function concat (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function digest (bytes: Uint8Array): Promise<Uint8Array> {
  const hashed = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return new Uint8Array(hashed)
}

function toLowercaseHex (bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * leaf = SHA-256( 0x00 || u32be(len(path)) || path || u64be(len(content)) || content )
 *
 * LENGTH PREFIXING IS NOT DECORATION -- exactly derive.ts's warning.
 * Concatenating path and content directly makes {path:"a",content:"bc"} and
 * {path:"ab",content:"c"} hash identically.
 */
async function leafDigest (entry: BundleEntry): Promise<Uint8Array> {
  const pathBytes = new TextEncoder().encode(entry.path)
  return digest(
    concat([
      Uint8Array.of(0x00),
      encodeField(pathBytes),
      encodeContentLength(entry.content.length),
      entry.content
    ])
  )
}

/** One leaf's canonical path paired with its digest, `"sha256:"`-prefixed lowercase hex. */
export interface PathLeaf {
  readonly path: string
  readonly leaf: string
}

/**
 * The bundle hash plus the full per-path leaf table it was computed from.
 * ./pin.ts persists `assets` as the pinned-asset set that answers T21's
 * fail-closed membership question ("is this requested path one this bundle
 * ever claimed?") -- the root alone cannot answer that.
 */
export interface BundleTree {
  readonly root: string
  readonly assets: readonly PathLeaf[]
}

/**
 * Computes the full tree: validates the entry set, then the root and every
 * leaf digest it was built from. See docs/architecture/bundle-hash.md for
 * the full specification; this docstring covers only what a caller needs to
 * know.
 *
 * Rejects (throws with code 'invalid') rather than hashing when:
 *  - there are zero entries;
 *  - any entry's path is not a structurally valid canonical path;
 *  - no entry's path is exactly MANIFEST_PATH;
 *  - two distinct entries share a collision key (case/Unicode-fold clash);
 *  - any single asset or the whole bundle exceeds its byte cap.
 *
 * Does NOT check that a leaf exists at the manifest's declared `entry` field
 * -- that requires parsing (untrusted) manifest content, which is the app
 * loader's job (build step 4), not this pure structural primitive's.
 */
export async function bundleTree (entries: readonly BundleEntry[]): Promise<BundleTree> {
  if (entries.length === 0) {
    throw fail('invalid', 'a bundle with zero entries has no content identity')
  }

  let totalBytes = 0
  let hasManifest = false
  const seenKeys = new Map<string, string>()

  for (const entry of entries) {
    if (!isValidCanonicalPath(entry.path)) {
      throw fail('invalid', `not a valid canonical path: ${JSON.stringify(entry.path)}`)
    }
    if (entry.content.length > MAX_ASSET_BYTES) {
      throw fail('invalid', `asset exceeds MAX_ASSET_BYTES: ${entry.path}`)
    }
    totalBytes += entry.content.length
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw fail('invalid', 'bundle exceeds MAX_BUNDLE_BYTES')
    }

    if (entry.path === MANIFEST_PATH) hasManifest = true

    const key = collisionKey(entry.path)
    const existing = seenKeys.get(key)
    if (existing !== undefined) {
      throw fail(
        'invalid',
        `paths collide under case/Unicode folding: ${JSON.stringify(existing)} and ` +
          `${JSON.stringify(entry.path)} -- this bundle cannot have one identity across platforms`
      )
    }
    seenKeys.set(key, entry.path)
  }

  if (!hasManifest) {
    throw fail('invalid', `bundle has no leaf at the reserved manifest path ${MANIFEST_PATH}`)
  }

  const sorted = [...entries].sort((a, b) =>
    compareUtf8Bytes(new TextEncoder().encode(a.path), new TextEncoder().encode(b.path))
  )
  const leaves = await Promise.all(sorted.map(leafDigest))

  const versionBytes = new TextEncoder().encode(BUNDLE_HASH_VERSION)
  const countBytes = new Uint8Array(4)
  new DataView(countBytes.buffer).setUint32(0, leaves.length, false)

  const root = await digest(concat([Uint8Array.of(0x01), encodeField(versionBytes), countBytes, ...leaves]))

  return {
    root: `sha256:${toLowercaseHex(root)}`,
    assets: sorted.map((entry, i) => ({ path: entry.path, leaf: `sha256:${toLowercaseHex(leaves[i]!)}` }))
  }
}

/** The bundle hash alone -- `(await bundleTree(entries)).root`. */
export async function bundleHash (entries: readonly BundleEntry[]): Promise<string> {
  return (await bundleTree(entries)).root
}
