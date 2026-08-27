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
- Two distinct canonical paths share a **collision key** (defined below).
- Any canonical path fails the rejection table (defined below).
- It exceeds a stated leaf-count or byte cap (see *Caps*, below).

> **Not in this list, deliberately:** *"no entry's canonical path equals `Manifest.entry`"*.
> An earlier draft of this document required it. It was cut on 2026-08-27 (owner decision):
> checking it means JSON-parsing the app's own manifest — untrusted bytes from a possibly
> hostile host — inside what is otherwise a pure byte-level function with no parse step and no
> interesting failure modes. **The check still happens; it belongs to the app loader**
> (`build-plan.md` step 4), which must parse the manifest anyway. A reimplementer of *this*
> document is not expected to perform it, and an implementation that skips it is conformant.

## Canonical path

The canonical path for an asset is `new URL(assetUrl).pathname` — the WHATWG URL Standard's
path-percent-encoded, `/`-prefixed pathname, computed from the URL the asset was fetched from,
**never from a local filesystem path**. Filesystem paths differ by separator on Windows and
case-fold on macOS/APFS; both are supported run-from-source targets, and deriving the canonical
path from the filesystem would make the hash depend on which OS installed the app.

Percent-encoding is preserved, not decoded: `/a%2Fb` and `/a/b` are distinct canonical paths. This
keeps the hashed string byte-identical to what a request line actually carries, which is what
lets the fail-closed membership check (`security-model.md` T21) compare like for like. (They are
nonetheless *colliding* for storage purposes and cannot appear in the same bundle — see
*Collision key*. Distinct-for-hashing and colliding-for-storage are different questions.)

**Only `https:` and `http:` URLs yield a canonical path.** Every other scheme returns nothing.
A `file:` URL parses perfectly well and has a `pathname` that reads exactly like an asset path —
`file:///etc/passwd` gives `/etc/passwd` — and must never be able to produce one. App assets are
fetched over https at the app's real origin (`ADR-0007`); `http:` is admitted only for the
localhost dev fixture (`build-plan.md` step 4).

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
- exceeds **1024 UTF-8 bytes** (this implementation's `MAX_PATH_BYTES`; a reimplementation may
  choose its own bound but must state it, since a bundle accepted by one and refused by the other
  has no single identity);
- contains a percent-escape that does not decode (`/%zz.js`). The URL parser passes such a
  sequence through untouched, so the path is "canonical" by the next rule, but no filename can be
  recovered from it and the collision key below cannot be computed for it;
- **is not itself already in canonical form** — re-deriving the canonical path from the canonical
  path must be a no-op. **Reject; never normalise.**

That last rule is the load-bearing one and the easiest to skip. It is what guarantees a hashed
path can still be *matched* later: `security-model.md` T21's membership check compares a pinned
path against a freshly derived canonical path by exact string equality. A path hashed in any
other spelling — `/a b.js` where the wire carries `/a%20b.js`, or a raw `ä` where the wire carries
`%C3%A4` — can never equal the request that asks for it. The asset is pinned and then permanently
denied. That fails closed, so it is not a serving bypass; the app simply does not work, on every
platform, forever.

### Collision key (the case/Unicode rule)

For every canonical path, compute a **collision key**: **percent-decode**, then Unicode
NFC-normalise, then apply Unicode simple case folding. If two *distinct* canonical paths in the
same bundle produce the *same* collision key, **the entire bundle is rejected**, on every
platform, including ones where the collision would not actually occur.

> **The percent-decode step comes first, and omitting it makes the whole rule inert.** This is
> not a refinement; it is the difference between the rule working and not working at all. A
> canonical path is `new URL(...).pathname`, which is **always pure ASCII** — every non-ASCII
> byte is already percent-encoded. So on real input, NFC normalisation of the *encoded* string is
> a no-op, and case folding reaches only the ASCII that survived encoding. An implementation that
> folds before decoding will accept every one of these:
>
> | | | collide because |
> |---|---|---|
> | `/caf%C3%A9.js` | `/cafe%CC%81.js` | NFC vs NFD spelling of `café.js` |
> | `/%C3%84.js` | `/%C3%A4.js` | `Ä` vs `ä` |
> | `/%C3%A4.js` | `/%c3%a4.js` | hex-digit case in the escape |
> | `/A.js` | `/%41.js` | escaped vs literal `A` |
> | `/a%2Fb` | `/a/b` | escaped vs literal separator |
> | `/.well-known/orivon.json` | `/%2Ewell-known/orivon.json` | **two manifests, one filename** |
>
> The last row is the one that matters. Both leaves reach the pinned asset set under a single
> root; both decode to one path in the code cache; whichever wins the write is the manifest whose
> capabilities are actually enforced — while the user consented to a root computed over the other
> one. That is a widened manifest inheriting a judged identity, the exact failure `ADR-0006` and
> `ADR-0009` chose manifest-as-leaf to prevent, reintroduced through the spelling of a path.
>
> This implementation shipped the fold-without-decode version and was corrected on 2026-08-27
> before any pin existed. It is called out at this length because the bug is invisible in testing
> unless the test data is written as `canonicalAssetPath()` output rather than as raw Unicode
> string literals — which is precisely how it survived its own test suite.

Worked examples of the rule firing: `/App.js` and `/app.js`; the six pairs in the table above.
Note that `/a%2Fb` and `/a/b` **still hash as distinct resources** (see *Canonical path*) — both
statements are true at once. They are distinct for hashing and colliding for storage, and a
bundle may therefore contain either but not both.

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
  sorts *after* U+E000–U+FFFF's UTF-8 encoding (starting `0xEE`–`0xEF`).

  > **Corrected 2026-08-27: this cannot currently be reached, and an earlier version of this
  > document oversold it.** The canonical-form rule requires every path to be
  > `new URL(...).pathname`, which is always pure ASCII — and for ASCII the two orders are
  > identical. So no *legal bundle* can distinguish them, and no test vector can either; vector
  > V5 below used to appear to, only because it hashed raw non-ASCII paths that the rejection
  > table now (and always should have) refuses. Specify and implement the byte comparison anyway
  > — it costs nothing, it is correct for any future construction that admits raw paths, and the
  > default-sort trap is real for anyone who relaxes canonicalisation later. But do not spend
  > review effort here: **the collision key above is where the Unicode risk actually lives**, and
  > it is where this implementation actually had a bug.
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

> **V5 was revised once, on 2026-08-27, and the window is now closed.** Its original inputs were
> raw supplementary-plane and private-use characters, which the rejection table refuses — the
> vector could not be produced by a conforming implementation. Re-expressed in the percent-encoded
> form a browser actually emits, and recomputed by the same independent reference implementation.
> This was possible only because **no pin had ever been written to disk**: build step 4 writes the
> first one, and after that no row here may be edited for any reason, including this one.
> V1–V4 did not move. V6 was added at the same time.

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
A and B **must** produce different roots.

**These two are *formula-level* vectors and are not legal bundles** — neither carries a leaf at
`/.well-known/orivon.json`, so a conforming implementation rejects both before hashing. They
exercise the length-prefix boundary in isolation. Check them against your `root`/`leaf`
computation directly, not through your bundle validator.

### V5 — non-ASCII paths, in the form they actually take

```
[
  { path: "/.well-known/orivon.json", content: '{"orivonApiVersion":0}' },
  { path: "/%F0%90%80%80.js", content: "x" },   // U+10000, supplementary plane
  { path: "/%EE%80%80.js",    content: "y" }    // U+E000, BMP private-use area
]
```
→ `sha256:9aebeec88db79ddc4244d8026f0f93aee26d8bcd686da283c77db35617467af9`

Sorted order is `/%EE%80%80.js`, then `/%F0%90%80%80.js`, then the manifest — because `%` is
`0x25` and `.` is `0x2e`, so **both encoded paths sort before the manifest**, which is the
opposite of what the original version of this vector showed. That inversion is the clearest
demonstration of the point: once paths are percent-encoded, sorting is plain ASCII sorting and
the UTF-8-versus-UTF-16 question does not arise.

**Revised 2026-08-27** — see the note under *Frozen test vectors*. The original V5 hashed the raw
characters (`/\u{10000}.js`, `/\u{E000}.js`) and produced
`sha256:2cb9aeca099886230482a7d8ea0fb3338aaf146466f301817c42f81306a8d53c`. Recorded here so an
implementation that computed the old value can tell which vector it matched, and so nobody
re-derives it and assumes drift. **Do not use the old value.**

### V6 — the per-path leaf table

The same three entries as V1. A root alone cannot answer T21's membership question, so an
implementation must also expose the per-path leaf digests it built the root from; these are
persisted in the pin record and are as much a one-way door as the root itself.

```
/.well-known/orivon.json  -> sha256:612c226ad5f32daa98f31de474342d9f6215339cc7f607b5052bbf57e0422872
/app.js                   -> sha256:fe2c01feec61bdeccff4b903bfca12c534a3c770d053bcdb6e7171ec60a41116
/index.html               -> sha256:e64a531c45ee108a04ea6ba8d43eb74810b50142a6f68d6d37a4f73389cc6975
```
→ root, unchanged from V1: `sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd`

Listed in sorted order, which is the order the root was computed in.

## Caps

Stated so two implementations agree on which bundles are refusable, not because any of these
numbers is a considered limit. **All four are provisional** (`open-questions.md` A15) and are
expected to be revisited before the app loader ships:

| Cap | Value | Why it exists |
|---|---|---|
| `MAX_PATH_BYTES` | 1024 | Bounds the rejection path and keeps a hostile path out of memory |
| `MAX_ASSET_BYTES` | 16 MiB | `crypto.subtle.digest` cannot stream, so each asset is briefly whole in memory |
| `MAX_BUNDLE_BYTES` | 64 MiB | Aggregate of the above |
| `MAX_BUNDLE_ENTRIES` | 4096 | The byte caps do not bound leaf *count*: 200k zero-byte entries pass both, and T21 re-hashes the whole cached tree at **every** load |

## What this document does not define

Signature formats, attestation verification, provider trust, or any second hash algorithm — see
`ADR-0009` for why those are deliberately out of scope. This document defines an identifier and
proves it stable; it says nothing about who may make a claim about that identifier.
