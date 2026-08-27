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
// ONE VECTOR HAS BEEN REVISED, ONCE, AND THE DOOR IS NOW SHUT. On 2026-08-27,
// before any pin had ever been written to disk, V5 was re-expressed because it
// hashed RAW non-ASCII paths that no fetched asset can present -- see its
// comment in the test file and ADR-0009's amendment. V1-V4 did not move. That
// window has closed: build step 4 writes the first real pin, and after it no
// vector in that table may be edited for any reason.
//
// WebCrypto, not node:crypto, for the same reason as ./derive.ts:
// `globalThis.crypto.subtle` is a global across browsers, Node and WASI, so
// this layer outlives the engine underneath it (ADR-0002).
//
// Split into two files (Rule 2, docs/development/code-guidelines.md):
// ./canonical-path.ts (what makes a path structurally valid, and its
// collision key) and this file (the tree/root construction over a validated
// entry set).

import { concat, frame } from './bytes.js'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES, collisionKey, describePath, isValidCanonicalPath } from './canonical-path.js'
import type { PathLeaf } from './canonical-path.js'
import { fail } from './errors.js'

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

/**
 * Ascending unsigned UTF-8 byte order. Deliberately NOT
 * `Array.prototype.sort()`'s default, which compares UTF-16 code units and
 * disagrees with UTF-8 byte order for any character above U+FFFF -- a
 * supplementary-plane character's UTF-16 surrogate pair (0xD800-0xDFFF)
 * sorts BELOW U+E000-U+FFFF in code-unit order but its UTF-8 encoding
 * (0xF0-0xF4) sorts ABOVE U+E000-U+FFFF's UTF-8 encoding (0xEE-0xEF).
 *
 * KEPT AS DEFENCE IN DEPTH, NOT AS A LOAD-BEARING RULE (corrected
 * 2026-08-27). Once isValidCanonicalPath enforces canonical form, every path
 * reaching this comparator is pure ASCII -- the URL parser percent-encodes
 * everything else -- and for ASCII the two orders are identical. So the
 * divergence described above cannot currently be reached, and vector V5 no
 * longer demonstrates it. The comparator stays because it costs nothing, it
 * is correct for any future construction that admits raw paths, and swapping
 * it for the default sort would be a silent trap for whoever does that.
 */
function compareUtf8Bytes (a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

function encodeContentLength (byteLength: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(byteLength), false)
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
      frame(pathBytes),
      encodeContentLength(entry.content.length),
      entry.content
    ])
  )
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
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw fail('invalid', `bundle exceeds MAX_BUNDLE_ENTRIES (${entries.length} > ${MAX_BUNDLE_ENTRIES})`)
  }

  let totalBytes = 0
  let hasManifest = false
  const seenKeys = new Map<string, string>()

  for (const entry of entries) {
    if (!isValidCanonicalPath(entry.path)) {
      throw fail('invalid', `not a valid canonical path: ${describePath(entry.path)}`)
    }
    if (entry.content.length > MAX_ASSET_BYTES) {
      throw fail('invalid', `asset exceeds MAX_ASSET_BYTES: ${describePath(entry.path)}`)
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
        `paths collide under percent-decoding/case/Unicode folding: ${describePath(existing)} and ` +
          `${describePath(entry.path)} -- this bundle cannot have one identity across platforms`
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

  const root = await digest(concat([Uint8Array.of(0x01), frame(versionBytes), countBytes, ...leaves]))

  return {
    root: `sha256:${toLowercaseHex(root)}`,
    assets: sorted.map((entry, i) => ({ path: entry.path, leaf: `sha256:${toLowercaseHex(leaves[i]!)}` }))
  }
}

/** The bundle hash alone -- `(await bundleTree(entries)).root`. */
export async function bundleHash (entries: readonly BundleEntry[]): Promise<string> {
  return (await bundleTree(entries)).root
}
