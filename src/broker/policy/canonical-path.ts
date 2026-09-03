// Canonical-path validation for a bundle asset, split out of ./bundle-hash.ts
// (Rule 2, docs/development/code-guidelines.md). Pure function, no I/O -- see
// ./README.md. Full specification: docs/architecture/bundle-hash.md,
// docs/decisions/ADR-0009.
//
// Structurally frozen the same way bundle-hash.ts is: ./pin.ts persists a
// record built from these functions, and a change here changes which paths an
// already-pinned app is allowed to serve.

import { WINDOWS_DEVICE_NAME_PATTERN } from './windows-device-names.js'

/**
 * The reserved canonical path every bundle must carry exactly one leaf at.
 * Fetched before first run (capability-api.md SSManifest).
 */
export const MANIFEST_PATH = '/.well-known/orivon.json'

/**
 * Leaf count cap. The byte caps alone do not bound the work: 200k zero-byte
 * entries pass both and still cost seconds of hashing, and T21 re-hashes the
 * whole cached tree at EVERY app load, not just at fetch.
 *
 * AI RECOMMENDATION, NOT AN OWNER DECISION, tracked as an open question
 * (open-questions.md A15) so it gets decided before the loader ships rather
 * than by default.
 */
export const MAX_BUNDLE_ENTRIES = 4096

/** Bounded so a hostile path cannot exhaust memory. See describePath for messages. */
const MAX_PATH_BYTES = 1024

const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/ // C0 and C1 control characters

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
export function describePath (path: string): string {
  const shown = path.length > 120 ? `${path.slice(0, 120)}...(${path.length} chars)` : path
  return JSON.stringify(shown)
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
  const decoded = decodePercentEscapes(path)
  if (decoded === null) return false

  // AND THE DECODED FORM MUST ITSELF BE SAFE. See isSafeDecodedPath.
  if (!isSafeDecodedPath(decoded)) return false

  // Kept though the re-derivation check above already rejects both: this is
  // the rule stated by name in the spec, and a reader looking for it should
  // find it rather than have to prove that URL normalisation implies it.
  const segments = path.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) return false

  return true
}

/** `a.js.` and `a.js ` both name `a.js` on Win32, which strips both. */
const TRAILING_DOT_OR_SPACE = /[. ]$/

/**
 * Reserved on Windows with or without an extension, and the same table
 * paths.ts refuses for the same reason (./windows-device-names.ts). `CON.txt`
 * is the device, `CONFIG` is not, so the test is on the component up to its
 * first dot. Case-insensitive here because, unlike paths.ts, nothing upstream
 * has already normalised case.
 */
const WINDOWS_DEVICE = new RegExp(WINDOWS_DEVICE_NAME_PATTERN, 'i')

/** `\` separates on Windows; `:` opens an NTFS stream; `|` is not a filename. */
const UNSAFE_DECODED_CHARS = /[\\:|]/

/**
 * Is the DECODED path safe to reconstruct as a file under the code cache?
 *
 * THE DECODED FORM IS WHAT THE FILESYSTEM SEES. That is the whole argument
 * collisionKey rests on, and until 2026-08-27 this module made it in one
 * place and not the other: it decoded to detect aliasing, then validated only
 * the encoded string. So `/%00.js` and `/..%2F..%2Fevil.js` were canonical,
 * hashed, and written into the pinned asset set -- which ADR-0009 makes the
 * map the code cache is laid out from. A cache writer must percent-decode to
 * recover a filename (otherwise `/fonts/Inter%20Regular.woff2` lands on disk
 * with a literal `%20`), and decoding those two yields a NUL byte and a
 * traversal out of the app's own cache directory.
 *
 * Every rule here is enforced ON EVERY PLATFORM, including ones where the
 * specific hazard does not exist -- the same choice paths.ts makes, for the
 * same reason: a security boundary with OS-dependent semantics is one nobody
 * can reason about, and a bundle must have ONE identity everywhere or it has
 * none.
 *
 * Deliberately NOT a general "safe filename" library. It rejects the classes
 * that alias or escape; it does not try to enumerate every filesystem's
 * quirks. Cost of a false positive is a loud rejection at install with a
 * named reason, which is the failure direction this design chooses everywhere.
 */
function isSafeDecodedPath (decoded: string): boolean {
  if (CONTROL_CHARS.test(decoded)) return false
  if (UNSAFE_DECODED_CHARS.test(decoded)) return false

  const segments = decoded.split('/')
  // A canonical path starts with '/', so segments[0] is always ''. Every other
  // segment must be a real, usable filename.
  for (const segment of segments.slice(1)) {
    if (segment.length === 0) return false // '//' or a trailing '/'
    if (segment === '.' || segment === '..') return false
    if (TRAILING_DOT_OR_SPACE.test(segment)) return false
    if (WINDOWS_DEVICE.test(segment.split('.')[0]!)) return false
  }

  return segments.length > 1
}

/** Percent-decodes, or null if any escape is malformed. Never throws. Exported for ../../loader/node-storage.ts's own decode-then-write step (Rule 3). */
export function decodePercentEscapes (path: string): string | null {
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
export function collisionKey (path: string): string {
  return (decodePercentEscapes(path) ?? path).normalize('NFC').toLowerCase()
}

/** One leaf's canonical path paired with its digest, `"sha256:"`-prefixed lowercase hex. */
export interface PathLeaf {
  readonly path: string
  readonly leaf: string
}
