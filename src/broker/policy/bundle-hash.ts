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

/**
 * Leaf count cap. The byte caps alone do not bound the work: 200k zero-byte
 * entries pass both and still cost seconds of hashing, and T21 re-hashes the
 * whole cached tree at EVERY app load, not just at fetch.
 *
 * Same status as the byte caps above -- AI RECOMMENDATION, NOT AN OWNER
 * DECISION, tracked as an open question (open-questions.md A15) so it gets
 * decided before the loader ships rather than by default.
 */
export const MAX_BUNDLE_ENTRIES = 4096

/** Bounded so a hostile path cannot exhaust memory. See describePath for messages. */
const MAX_PATH_BYTES = 1024

const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/  // C0 and C1 control characters

/**
 * Base for re-deriving a path through the URL parser. Never appears in a hash
 * and never escapes this module -- only `pathname` is read from the result.
 * `.invalid` is the reserved never-resolvable TLD (RFC 2606).
 */
const CANONICALISATION_BASE = 'https://canonicalisation.invalid'

/**
 * The schemes an app asset can be fetched over. ADR-0007 keeps a cached bundle
 * at its real https origin; the dev-mode fixture app (build step 4) is served
 * over http on localhost. Anything else -- `file:`, `data:`, a custom scheme --
 * has a `pathname` that reads like an asset path but is not one, and must not
 * be able to produce a canonical path at all.
 */
const ASSET_SCHEMES = new Set(['https:', 'http:'])

/**
 * A hostile path is bounded before it reaches an error message. The path cap
 * itself is checked mid-validation, so by the time a later check fails the
 * string is already short -- but the length check's own message is not, and
 * neither is any future caller's.
 */
function describePath (path: string): string {
  const shown = path.length > 120 ? `${path.slice(0, 120)}...(${path.length} chars)` : path
  return JSON.stringify(shown)
}

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

  if (!ASSET_SCHEMES.has(parsed.protocol)) return null

  return isValidCanonicalPath(parsed.pathname) ? parsed.pathname : null
}

/**
 * Structural validity of a canonical path, independent of how it was
 * produced. bundleTree() re-checks every entry's path against this rather
 * than trusting the caller ran it through canonicalAssetPath -- the same
 * "checked here, not trusted from the caller" stance derive.ts takes with
 * MIN_SEED_BYTES.
 *
 * Exported so ./pin.ts can hold a record read back off disk to the same
 * standard. The two modules disagreeing about what a pinned path is would be
 * a hole in whichever one is more permissive.
 */
export function isValidCanonicalPath (path: string): boolean {
  if (path.length === 0 || !path.startsWith('/')) return false
  // UTF-8 length is never below UTF-16 code-unit count, so this bounds the
  // encode below without changing which paths are accepted.
  if (path.length > MAX_PATH_BYTES) return false
  if (CONTROL_CHARS.test(path)) return false
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) return false

  // THE CANONICAL-FORM RULE (bundle-hash.md rejection table). Re-deriving a
  // canonical path from itself must be a no-op; anything else is REJECTED,
  // never repaired.
  //
  // This is not pedantry about spec conformance. `isPinnedPath` compares a
  // pinned path against `canonicalAssetPath()` output at request time, by
  // exact string equality. A path hashed in any other spelling -- '/a b.js'
  // for '/a%20b.js', or a raw 'ä' for '%C3%A4' -- can never match the request
  // that asks for it, so the asset is pinned and permanently denied. Fail-
  // closed, so not a serving bypass, but the app simply does not work.
  //
  // It also subsumes the '.'/'..' segment rule below, which URL normalisation
  // collapses, and the U+2028/U+2029 gap the C0/C1 class does not cover.
  let reDerived: string
  try {
    reDerived = new URL(path, CANONICALISATION_BASE).pathname
  } catch {
    return false
  }
  if (reDerived !== path) return false

  // Percent-escapes must be decodable. The URL parser passes '%zz' through
  // untouched, so such a path is "canonical" by the check above -- but no
  // filename can be recovered from it, and collisionKey below must never be
  // handed a string that throws inside a security decision.
  if (decodePercentEscapes(path) === null) return false

  // Kept though the re-derivation check above already rejects both: this is
  // the rule stated by name in the spec, and a reader looking for it should
  // find it rather than have to prove that URL normalisation implies it.
  const segments = path.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) return false

  return true
}

/** Percent-decodes, or null if any escape is malformed. Never throws. */
function decodePercentEscapes (path: string): string | null {
  if (!path.includes('%')) return path
  try {
    return decodeURIComponent(path)
  } catch {
    return null
  }
}

/**
 * PERCENT-DECODE, then NFC-normalise, then simple-case-fold: does this path
 * name the same file on disk as another one? Used only to decide whether the
 * bundle must be rejected before hashing -- NEVER inside the hash itself.
 *
 * THE DECODE STEP IS THE WHOLE POINT, and its absence made this function
 * inert for every case it was written for (fixed 2026-08-27, before any pin
 * existed). A canonical path is `new URL(...).pathname`, which is ALWAYS pure
 * ASCII -- the parser percent-encodes every non-ASCII byte before this code
 * ever sees it. So on the real inputs:
 *
 *   - `.normalize('NFC')` was a no-op on every path that can actually occur,
 *     and the NFC/NFD rule ADR-0009 records as an OWNER DECISION never fired;
 *   - `.toLowerCase()` folded only surviving ASCII, so `/%C3%84.js` ('Ä') and
 *     `/%C3%A4.js` ('ä') read as unrelated;
 *   - `/.well-known/orivon.json` and `/%2Ewell-known/orivon.json` -- two
 *     manifests, one filename -- read as unrelated.
 *
 * Decoding first also catches the encoded separator: `/a%2Fb` and `/a/b` hash
 * as the distinct resources bundle-hash.md says they are, yet resolve to one
 * path on disk, so they still cannot coexist in a single bundle.
 *
 * Safe to decode unconditionally: isValidCanonicalPath rejects any path whose
 * escapes do not decode, so this cannot be reached with one that throws.
 *
 * Approximation, stated plainly: `.toLowerCase()` is the closest thing the JS
 * standard library offers to Unicode simple case folding, but it is not the
 * full Unicode Default Case Folding table (which differs from locale-
 * independent lowercasing for a handful of characters, e.g. the German sharp
 * s under some folding modes). Good enough for the collisions macOS and
 * Windows filesystems actually produce; not a formal guarantee for every
 * codepoint.
 */
function collisionKey (path: string): string {
  return (decodePercentEscapes(path) ?? path).normalize('NFC').toLowerCase()
}

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
