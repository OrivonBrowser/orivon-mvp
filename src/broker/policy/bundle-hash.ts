// The bundle hash: an app's content identity. Pure function, no I/O -- see
// ./README.md. Full specification, reasoning and frozen vectors:
// docs/architecture/bundle-hash.md, docs/decisions/ADR-0009.
//
// THIS CONSTRUCTION IS A ONE-WAY DOOR (ADR-0009). Once the first pin is
// persisted, changing anything below invalidates every stored pin and orphans
// every attestation issued against the old root. A failing row in
// ./tests/bundle-hash.test.ts's frozen vector table means THE CHANGE IS WRONG --
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

/** Shared because it is stateless -- matches derive.ts's UTF8, same reason: allocating one per call was pure waste. */
const UTF8 = new TextEncoder()

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
 * Owner decision (A15): one asset may be up to 64 MiB, a whole bundle up to
 * 512 MiB -- sized for a real built frontend (a 31 MB wasm-heavy chunk, a
 * 37 MB bundle) with headroom. They bound download and disk, not memory: the
 * loader hashes each leaf streamingly (src/loader/leaf-hash.ts over
 * `leafPrefix`), never holding an asset whole. `bundleTree` below still
 * digests whole buffers, one leaf at a time, for callers already holding them.
 */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

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

function fromLowercaseHex (hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * leaf = SHA-256( 0x00 || u32be(len(path)) || path || u64be(len(content)) || content )
 *
 * `leafPrefix` is everything before `content`, exported so a streaming
 * hasher (src/loader/leaf-hash.ts) feeds the identical preimage: the byte
 * layout stays defined here, once. The length must be known before the
 * first content byte, so a streaming caller counts the bytes first.
 *
 * LENGTH PREFIXING IS NOT DECORATION -- exactly derive.ts's warning.
 * Concatenating path and content directly makes {path:"a",content:"bc"} and
 * {path:"ab",content:"c"} hash identically.
 */
export function leafPrefix (path: string, contentLength: number): Uint8Array<ArrayBuffer> {
  return concat([Uint8Array.of(0x00), frame(UTF8.encode(path)), encodeContentLength(contentLength)])
}

async function leafDigest (entry: BundleEntry): Promise<string> {
  return `sha256:${toLowercaseHex(await digest(concat([leafPrefix(entry.path, entry.content.length), entry.content])))}`
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
 * One leaf already digested -- by `bundleTree` below, or streamingly by a
 * caller that never held the content whole. `byteLength` is the content's
 * length, checked against the caps exactly as whole content would be.
 */
export interface LeafEntry {
  readonly path: string
  readonly byteLength: number
  readonly leaf: string
}

const LEAF_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * The structural rules every leaf set must pass before a root is computed --
 * shared by `bundleTree` (checked before any content is hashed) and
 * `bundleTreeFromLeaves`, so the two can never accept different sets.
 */
function validateLeafSet (items: ReadonlyArray<{ readonly path: string, readonly byteLength: number }>): void {
  if (items.length === 0) {
    throw fail('invalid', 'a bundle with zero entries has no content identity')
  }
  if (items.length > MAX_BUNDLE_ENTRIES) {
    throw fail('invalid', `bundle exceeds MAX_BUNDLE_ENTRIES (${items.length} > ${MAX_BUNDLE_ENTRIES})`)
  }

  let totalBytes = 0
  let hasManifest = false
  const seenKeys = new Map<string, string>()

  for (const item of items) {
    if (!isValidCanonicalPath(item.path)) {
      throw fail('invalid', `not a valid canonical path: ${describePath(item.path)}`)
    }
    if (item.byteLength > MAX_ASSET_BYTES) {
      throw fail('invalid', `asset exceeds MAX_ASSET_BYTES: ${describePath(item.path)}`)
    }
    totalBytes += item.byteLength
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw fail('invalid', 'bundle exceeds MAX_BUNDLE_BYTES')
    }

    if (item.path === MANIFEST_PATH) hasManifest = true

    const key = collisionKey(item.path)
    const existing = seenKeys.get(key)
    if (existing !== undefined) {
      throw fail(
        'invalid',
        `paths collide under percent-decoding/case/Unicode folding: ${describePath(existing)} and ` +
          `${describePath(item.path)} -- this bundle cannot have one identity across platforms`
      )
    }
    seenKeys.set(key, item.path)
  }

  if (!hasManifest) {
    throw fail('invalid', `bundle has no leaf at the reserved manifest path ${MANIFEST_PATH}`)
  }
}

/**
 * The root over leaves already digested. Validates exactly what `bundleTree`
 * validates (`validateLeafSet`), plus each leaf's own `sha256:` shape.
 */
export async function bundleTreeFromLeaves (leaves: readonly LeafEntry[]): Promise<BundleTree> {
  validateLeafSet(leaves)
  for (const entry of leaves) {
    if (!LEAF_PATTERN.test(entry.leaf)) throw fail('invalid', `not a sha256 leaf digest: ${describePath(entry.path)}`)
  }

  const sorted = [...leaves].sort((a, b) =>
    compareUtf8Bytes(UTF8.encode(a.path), UTF8.encode(b.path))
  )

  const versionBytes = UTF8.encode(BUNDLE_HASH_VERSION)
  const countBytes = new Uint8Array(4)
  new DataView(countBytes.buffer).setUint32(0, sorted.length, false)
  const leafBytes = sorted.map((entry) => fromLowercaseHex(entry.leaf.slice('sha256:'.length)))

  const root = await digest(concat([Uint8Array.of(0x01), frame(versionBytes), countBytes, ...leafBytes]))

  return {
    root: `sha256:${toLowercaseHex(root)}`,
    assets: sorted.map((entry) => ({ path: entry.path, leaf: entry.leaf }))
  }
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
 * Leaves are digested one at a time, so at most one asset's preimage copy
 * exists at once on top of the caller's own buffers.
 *
 * Does NOT check that a leaf exists at the manifest's declared `entry` field
 * -- that requires parsing (untrusted) manifest content, which is the app
 * loader's job (build step 4), not this pure structural primitive's.
 */
export async function bundleTree (entries: readonly BundleEntry[]): Promise<BundleTree> {
  validateLeafSet(entries.map((entry) => ({ path: entry.path, byteLength: entry.content.length })))
  const leaves: LeafEntry[] = []
  for (const entry of entries) {
    leaves.push({ path: entry.path, byteLength: entry.content.length, leaf: await leafDigest(entry) })
  }
  return await bundleTreeFromLeaves(leaves)
}

/** The bundle hash alone -- `(await bundleTree(entries)).root`. */
export async function bundleHash (entries: readonly BundleEntry[]): Promise<string> {
  return (await bundleTree(entries)).root
}
