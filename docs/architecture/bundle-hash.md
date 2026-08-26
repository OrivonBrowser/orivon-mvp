# The bundle hash

**Audience: anyone reimplementing this outside this repository** — a third-party Web3 Score
provider, an independent auditor, a future port. If you are working inside this codebase, read
`ADR-0009` for *why*; this document is the *what*, precise enough to reimplement bug-for-bug
without reading a line of TypeScript.

The bundle hash is an Orivon app's **content identity**. Two bundles have the same hash if and
only if they contain the same files at the same paths with the same bytes. It is what
`ADR-0006`'s attestation model signs over (*"provider P asserts: bundle `sha256:ab12…` is Site
Level 4"*), what `security-model.md` T6/T19/T21 pin against, and what `decideUpdate()`
(`src/broker/policy/update.ts`) compares to decide whether an update installs silently, re-prompts,
or is rejected.

**This construction is a one-way door** (`ADR-0009`). Changing anything below invalidates every
pin already persisted and orphans every attestation issued against the old root.

## What is hashed

**Leaf set** = the app's manifest (`/.well-known/orivon.json`, exact fetched bytes) plus every
frontend asset in the app's code cache. Never the app's mutable file storage (`files/`,
`ADR-0003`) — that is user data, not app identity.

A bundle is **rejected before hashing** — no root is computed — if any of the following hold:

- It contains zero entries.
- No entry's canonical path is `/.well-known/orivon.json`.
- No entry's canonical path equals `Manifest.entry` as declared in that manifest.
- Two distinct canonical paths share a **collision key** (defined below).
- Any canonical path fails the rejection table (defined below).

## Canonical path

The canonical path for an asset is `new URL(assetUrl).pathname` — the WHATWG URL Standard's
path-percent-encoded, `/`-prefixed pathname, computed from the URL the asset was fetched from,
**never from a local filesystem path**. Filesystem paths differ by separator on Windows and
case-fold on macOS/APFS; both are supported run-from-source targets, and deriving the canonical
path from the filesystem would make the hash depend on which OS installed the app.

Percent-encoding is preserved, not decoded: `/a%2Fb` and `/a/b` are distinct canonical paths. This
keeps the hashed string byte-identical to what a request line actually carries, which is what
lets the fail-closed membership check (`security-model.md` T21) compare like for like.

Verified empirically (Node 24.11.1, 2026-08-26 — see `ADR-0009`'s coordination notes for the
Electron-context caveat):

```
new URL("https://x.example/a%2Fb/c.js").pathname     -> "/a%2Fb/c.js"   (encoding preserved)
new URL("https://x.example/ä/🙂.js").pathname          -> "/%C3%A4/%F0%9F%99%82.js"
new URL("https://x.example/App.js").pathname           -> "/App.js"      (case preserved, not folded)
new URL("https://x.example/a b.js").pathname            -> "/a%20b.js"
new URL("https://x.example/%C3%A4.js").pathname         -> "/%C3%A4.js"  (already-encoded input is stable)
```

Both Node and Chromium (and therefore Electron's main and renderer processes) implement the same
WHATWG URL Standard, so this is spec-defined behaviour, not an implementation quirk of one engine.

### Rejection table

A canonical path is rejected (the whole bundle is refused) if it:

- is empty, or does not start with `/`;
- contains a `.` or `..` path segment that survived URL normalisation;
- contains a NUL byte or any C0/C1 control character;
- exceeds a stated per-path length bound (implementation-defined; document the number chosen);
- is not itself already in canonical form (i.e. re-deriving the canonical path from the canonical
  path must be a no-op — reject rather than normalise).

### Collision key (the case/Unicode rule)

For every canonical path, compute a **collision key**: Unicode NFC-normalise, then apply Unicode
simple case folding. If two *distinct* canonical paths in the same bundle produce the *same*
collision key — for example `/App.js` and `/app.js`, or two NFC/NFD spellings of one filename —
**the entire bundle is rejected**, on every platform, including ones where the collision would not
actually occur.

This is deliberate, not a compatibility shim: the on-disk cache on macOS (HFS+/APFS
case-insensitivity, NFD normalisation) and Windows (case-insensitive filesystems) can hold only
one of two colliding paths, so a bundle that "works" on Linux would silently reconstruct to a
different pinned tree elsewhere. **The hash itself is never case-folded or Unicode-normalised** —
only the collision check is. `/App.js` and `/app.js`, when they do not collide with anything else
in the same bundle, hash as the distinct resources they are.

## What is hashed per leaf

Leaf content is the **raw fetched bytes**, unmodified: no line-ending translation, no
minification, no re-serialisation of JSON (including the manifest itself). Any content
normalisation would build a collision into an integrity function by construction — two different
byte sequences a browser could legitimately receive would hash identically.

## The construction

All integers are unsigned, big-endian. `||` is byte concatenation. `len(x)` is the byte length of
`x`.

```
leaf_i = SHA-256( 0x00
                || u32be(len(path_utf8_i))    || path_utf8_i
                || u64be(len(content_i))      || content_i )

root   = SHA-256( 0x01
                || u32be(len(VERSION_STRING)) || VERSION_STRING
                || u32be(n)
                || leaf_0 || leaf_1 || … || leaf_{n-1} )

VERSION_STRING = "orivon-bundle-v1"   (UTF-8 bytes)
```

- `path_utf8_i` is the canonical path (see above), encoded as UTF-8.
- `content_i` is the leaf's raw bytes (see above).
- **Leaves are sorted by ascending unsigned byte order of `path_utf8_i` before being
  concatenated into the root.** This is byte-order comparison of the UTF-8 encoding, explicitly
  **not** a comparison of UTF-16 code units (as `Array.prototype.sort()` performs by default in
  JavaScript). The two orders disagree for any path containing a character above U+FFFF: a
  supplementary-plane character encodes as a UTF-16 surrogate pair (`0xD800`–`0xDFFF`) that sorts
  *before* U+E000–U+FFFF in UTF-16 code-unit order, but its UTF-8 encoding (starting `0xF0`–`0xF4`)
  sorts *after* U+E000–U+FFFF's UTF-8 encoding (starting `0xEE`–`0xEF`). Get this wrong and two
  otherwise-correct implementations will disagree about a bundle's identity the first time an
  asset filename uses an emoji or a CJK Extension character.
- `n` is the number of leaves (after sorting; sorting does not change `n`).

### Why each element is present

| Element | Purpose |
|---|---|
| `0x00` / `0x01` prefix | Domain separation. A leaf digest can never be replayed as a valid root preimage, and vice versa. Also means a single-leaf bundle's root is never equal to that leaf's own digest. |
| `VERSION_STRING`, length-prefixed | A namespace, carried the same way `derive.ts`'s `KDF_SALT` carries `"orivon-kdf-v1"`. A future v2 construction changes this string; v1 pins remain valid and distinguishable rather than colliding with v2 ones. |
| Length prefix on every field | Without it, `{path:"a", content:"bc"}` and `{path:"ab", content:"c"}` produce byte-identical input to the hash function. |
| `u32be(n)` | Makes the leaf-list encoding injective by construction (4 bytes), rather than relying on an argument that no leaf list is a byte-for-byte prefix of another. |
| `u64be` for content length | 4 GiB is not a bound this construction wants to assert about a future asset; the extra 4 bytes over `u32be` cost nothing. |

## Encoding the root as a string

`"sha256:" + lowercase-hex(root)` — 7 + 64 = 71 ASCII characters, e.g.
`sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd`.

**Lowercase hex only.** `src/broker/policy/update.ts`'s `isSameBundle` already normalises both
sides of its comparison with `.trim().toLowerCase()`, on the stated assumption that this can only
merge two spellings of the *same* digest, never two different ones. That assumption is true for a
single-case alphabet (hex) and false for a mixed-case one (base64) — a base64 root would silently
turn that comparison into a bug. The `"sha256:"` prefix is itself lowercase and survives
`trim()`/`toLowerCase()` unchanged.

v0 implementations **must reject** any string not starting with the literal `sha256:` prefix. The
prefix is a namespace reserved for future algorithm agility, not a field to negotiate.

## Empty and single-file bundles

A bundle with **zero** leaves is rejected before hashing (see above) — it is not given the root
the formula would otherwise produce, because every empty bundle would then share one universal
hash matching any other empty response, truncated fetch, or 404-served-as-index.

A bundle with **exactly one** leaf is hashed with no special case. The `0x01` + version-string
prefix on the root computation guarantees the root differs from that single leaf's own digest
(vector V3 below demonstrates this).

## Frozen test vectors

Computed 2026-08-26 by an independent reference implementation (`node:crypto`'s `createHash`,
not `bundle-hash.ts`), so this table cannot be a recording of that implementation's own bugs. If
a change to `bundle-hash.ts` makes any vector below fail, **the change is wrong** — do not
regenerate the vector. A genuine v2 construction adds a new table under a new version string; it
never edits this one.

### V1 — three-file bundle, including the manifest

```
[
  { path: "/.well-known/orivon.json", content: '{"orivonApiVersion":0}' },
  { path: "/index.html",              content: "<!doctype html><title>a</title>" },
  { path: "/app.js",                  content: "console.log(1)" }
]
```
→ `sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd`

### V2 — order independence

The same three entries as V1, supplied in the order `[app.js, manifest, index.html]`.
→ `sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd` (identical to V1)

### V3 — single-leaf bundle

```
[ { path: "/.well-known/orivon.json", content: "{}" } ]
```
→ root: `sha256:d7cc8d092809e3f091d7f11a7dcccfceba519540a5f5730f80068b371b358e25`
→ that single leaf's own digest (must differ from the root above):
  `4c1f4a74edebb25f62e547b5741793f5f759fdadd631fac073557ef8e78e5deb`

### V4 — injectivity of length-prefixing

```
A: [ { path: "/a",  content: "bc" } ]  -> sha256:295023c3aee9987672b4ea79cf418b70355f1ed3fca9c35242a7e9d63a772c65
B: [ { path: "/ab", content: "c"  } ]  -> sha256:cb8d15aeab6efe4cce6370edea69ec60dc5fb8be40cda93f9e9b43f7c0749d26
```
A and B **must** produce different roots. (Note: `/a` and `/ab` fail the leading-slash-plus-shape
rules only trivially here — this vector exists purely to exercise the length-prefix boundary, not
path validity.)

### V5 — UTF-8 byte order vs UTF-16 code-unit order

```
[
  { path: "/.well-known/orivon.json", content: '{"orivonApiVersion":0}' },
  { path: "/\u{10000}.js", content: "x" },   // U+10000, supplementary plane
  { path: "/\u{E000}.js",  content: "y" }    // U+E000, BMP private-use area
]
```
UTF-16 code-unit comparison would sort the U+10000 entry before the U+E000 one (its leading
surrogate is `0xD800`, less than `0xE000`). **Correct UTF-8 byte-order comparison sorts the
U+E000 entry first** (its UTF-8 encoding starts `0xEE`; U+10000's starts `0xF0`) — so the full
sorted order is manifest (`.` is `0x2e`), then U+E000, then U+10000.
→ `sha256:2cb9aeca099886230482a7d8ea0fb3338aaf146466f301817c42f81306a8d53c`

A reference implementation that sorts by UTF-16 code units instead of UTF-8 bytes will compute a
**different** root for this vector. That mismatch is the entire point of including it.

## What this document does not define

Signature formats, attestation verification, provider trust, or any second hash algorithm — see
`ADR-0009` for why those are deliberately out of scope. This document defines an identifier and
proves it stable; it says nothing about who may make a claim about that identifier.
