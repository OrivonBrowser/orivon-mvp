# ADR-0009: The bundle hash is an app's content identity

- **Status:** accepted, **amended 2026-08-27** (see §Amendment)
- **Date:** 2026-08-26
- **Type:** architecture / security
- **Decided by:** owner (manifest-as-leaf, scope, and the case-collision rule), AI recommendation
  for the byte-level construction

> **Amendment 2026-08-27 supersedes parts of the text below.** Two rounds of review found that
> the case-collision rule was not firing at all, and that path validation checked only the
> encoded spelling and not the decoded one. Four decisions followed. **Read §Amendment at the
> foot of this document before relying on §Decision or §Reasoning** — specifically, §Reasoning's
> `Manifest.entry` rejection rule is withdrawn, and its sort-order argument is downgraded.

## Decision
An app's **bundle hash** is a single SHA-256 root computed over the manifest plus every frontend
asset in its code cache — a flat, sorted, length-prefixed list hash, never a binary Merkle tree.
It is rendered as the string `"sha256:" + lowercase-hex(32 bytes)`. The exact construction is
`docs/architecture/bundle-hash.md`; this ADR records that it exists, why it takes this shape, and
that it is a **one-way door**.

The manifest at `/.well-known/orivon.json` is a leaf, hashed by its exact fetched bytes. A bundle
whose paths collide under case-folding or Unicode normalisation (`/App.js` vs `/app.js`) is
**rejected at install**, on every platform, including ones where it would technically run.

## Context
`ADR-0005` (evening amendment) and `ADR-0006` both make "the bundle hash" load-bearing without
ever defining it:

> the signing mechanism was **load-bearing in three ADRs and specified nowhere**: no signature
> format, no covered bytes, no detached-signature location, no key generation, no tooling, and
> no build step. (`ADR-0005`)

> A Web3 Score provider does not score a site; it signs a statement over a **bundle hash** …
> Changed content means a changed hash. (`ADR-0006`)

Swap "signing" for "hashing" and `ADR-0005`'s sentence was true of this repository until this ADR:
`src/contracts/` has zero occurrences of hash/pin/integrity, `sha256` is specified only for
origin→directory-name (`security-model.md` T13b), and `stream/broker-05-update-decision`'s
`decideUpdate()` already compares `pinnedHash`/`newHash` as opaque strings computed by nobody,
nowhere. **This ADR exists so that sentence cannot be written about hashing.**

It is settled now, before build step 4 (the app loader) writes the first pin, for the same reason
`ADR-0003` settled origin first: changing the construction after the first pin is persisted
invalidates every stored pin and orphans every future attestation.

## Alternatives considered

**Binary Merkle tree over the leaves**, rejected. `security-model.md` T21's fail-closed rule
("a same-origin request whose path is not in the pinned set is denied, not fetched") forces the
broker to persist the full path→digest map regardless of tree shape, which removes a Merkle
tree's only real advantage (verifying membership without holding the whole list). A flat list
hash also avoids two well-known Merkle footguns a third-party reimplementer would have to get
right independently: the odd-node-duplication class (CVE-2012-2459) and leaf/internal domain
separation (RFC 6962 §2.1). A flat construction has no tree shape to get wrong.

**CIDv1 / UnixFS as the root encoding**, rejected. It reads as "D3 comes free," but CIDv1+UnixFS
is a chunking and DAG-layout specification, not an encoding — matching it means matching a
chunker and DAG shape exactly, a large hidden dependency on IPFS, which is out of MVP scope
(`mvp-scope.md`). `"sha256:"` keeps an algorithm-agility slot open at zero cost.

**Hashing only the frontend assets, not the manifest**, rejected. It matches what
`update.ts`'s current comment assumes ("the manifest is served separately from the bundle"), but
it lets a host keep an attested hash while serving a manifest that requests
`connect: ["*:*"]` — a judged score silently inherited by different authority, the exact failure
`ADR-0006` chose bundle-hash attestation to prevent ("a score cannot be silently inherited").
Owner decision: the manifest is a leaf.

**Folding case/Unicode variants together in the hash** (treat `/App.js` and `/app.js` as one
resource), rejected. An integrity function that cannot distinguish two paths a case-sensitive
origin actually serves differently has a collision built into it — the same defect class as
content normalisation. The alternative, silently keeping both apart while the on-disk cache
(macOS, Windows) can hold only one, produces a pin that can never be reconstructed. Owner
decision: reject the bundle outright.

**Streaming digest via `node:crypto`**, rejected for the same reason `derive.ts` rejects it:
WebCrypto (`globalThis.crypto.subtle`) is a global across browsers, Node and WASI, so the durable
layer does not tie itself to the disposable one (`ADR-0002`). `crypto.subtle.digest` cannot
stream, so each asset is briefly whole in memory — accepted, with explicit byte caps, given
`ADR-0005`'s stated 2–4 MB frontend size and that torrent payloads live in `files/`, never in the
pinned set.

## Reasoning

**Domain separators (`0x00` leaf / `0x01` root) and a versioned salt string
(`"orivon-bundle-v1"`), length-prefixed, exactly mirroring `derive.ts`'s `KDF_SALT` pattern on
`stream/broker-06-keys`.** A leaf digest can never be read back as a valid root preimage. A v2
construction changes the version string and adds vectors beside the existing ones; it never edits
them, because every pin already issued was computed under v1.

**Length-prefix every field.** Without it, `{path:"a",content:"bc"}` and `{path:"ab",content:"c"}`
hash identically — the exact collision `derive.ts` documents for `("app","abc")` vs
`("ap","pabc")`.

**Canonical path = `new URL(assetUrl).pathname`, percent-encoded, never the filesystem path.**
Filesystem paths differ by separator on Windows and case-fold on macOS — both supported
run-from-source targets, and the same bug class T13b already had to solve for origin→directory
names.

**Sort by ascending unsigned UTF-8 bytes, explicitly not `Array.prototype.sort()`.**
JavaScript's default comparator orders UTF-16 code units, which disagrees with UTF-8 byte order
for anything above U+FFFF. Invisible until an asset filename contains an emoji or a CJK-extension
character — then two otherwise-correct implementations (one in TypeScript, one in a provider's
Go or Rust) disagree about an app's identity permanently.

**Lowercase hex is forced, not chosen.** `update.ts`'s `isSameBundle` already calls
`.trim().toLowerCase()` on both sides, with a correctness argument ("normalising can merge two
spellings of the SAME digest but can never merge two different digests") that holds only for a
single-case alphabet. Base64 would silently turn that shipped, mutation-tested function into a
bug. `"sha256:"` survives `trim()`/`toLowerCase()` unchanged.

**A bundle with zero leaves, or missing the manifest leaf, or missing a leaf at
`Manifest.entry`, is rejected before hashing** — not given a root. The formula defines one for
`n = 0`, and that is exactly the danger: every empty bundle would share one universal hash, so a
pin against it would match any other empty response, truncated fetch, or 404-as-index.

**DDOC compatibility is a tiebreaker, not a goal.** `native-ddoc-specs.md` describes lists of
(relative path, hash) pairs — a flat list is the more reusable primitive if DDOC ever lands, and
this ADR claims only that: **not** that DDOC "drops in." DDOC's membership question is
runtime-observed (files a page actually loads, via headless Chromium); this construction's is
static (files in the cached bundle). DDOC's trust anchor is DNS, forgeable on ICANN domains
(`open-questions.md` A4b); this construction's is TOFU at install. And `open-questions.md` C2
already records DDOC's unlisted-file rule as unsound — the fail-closed pinned-asset set this ADR
enables is the strict-mode rule that gap needs, should DDOC ever return.

## Consequences

- `src/broker/policy/bundle-hash.ts` implements the construction as a pure function — see the
  spec for the exact byte layout and frozen golden vectors.
- `src/broker/policy/pin.ts` defines the on-disk pin record, holding the full path→leaf map (not
  only the root), because that map is what answers T21's fail-closed question. Persisted outside
  `code/` so the pin record is not itself a leaf.
- **`Manifest.version` gets a semver + ordering doc comment** in `src/contracts/manifest.ts`
  (contracts-only PR, after this ADR states the rule), matching what `update.ts`'s
  `compareVersions` already implements de facto.
- **`versionFloor` does not live in the pin record.** It must survive an uninstalled/reinstalled
  app — `update.ts` is explicit that it is "the highest version *ever* installed," and a floor
  that dies with the pin is a rollback oracle. It belongs in the grant ledger / browser-secrets
  tier, which `ADR-0003`'s four-tier table already treats as surviving app uninstall.
- **Pin lifetime, closing a gap `ADR-0003`'s tier table left open:** uninstalling an app deletes
  its pin record and code cache; the version floor persists. Revoking a single grant (e.g. `fs`)
  deletes neither — it does not change what code is installed.
- **`update.ts`'s comment at the `isSameBundle` call site becomes stale**, not its logic: "the
  manifest is served separately from the bundle" no longer holds once the manifest is a leaf. The
  ordering it defends — the pattern check must not be short-circuited by an unchanged hash —
  stays correct either way. Flagged to the `broker-05` owner as a coordination point, not edited
  directly.
- **The algorithm is public via specification and frozen test vectors, not via a shared code
  import.** A third-party score provider written in Go or Rust cannot import a TypeScript type;
  what it needs is `docs/architecture/bundle-hash.md`, playing the same role for `bundle-hash.ts`
  that `capability-api.md` plays for `src/contracts/`.
- **Explicitly out of this ADR's scope:** signature format, attestation verification, provider
  trust, key handling (`ADR-0005`'s stated reason: no provider exists to exercise a mechanism
  for), DDOC's DNS anchor and two-level tree, CID/IPFS delivery, and any second hash algorithm.
  v0 accepts `"sha256:"` only — a namespace, not a negotiation.
- **AI recommendation, owner to confirm separately:** the specific per-asset and per-bundle byte
  caps needed because `crypto.subtle.digest` holds each asset whole in memory.

## Reversibility
- **Cost to reverse:** one-way door once the first pin is persisted, the same class as the origin
  definition (`ADR-0003`) and cached-bundle-origin (`ADR-0007`). A construction change afterward
  invalidates every stored pin and orphans every attestation issued against the old root.
- **What would make us revisit:** a second hash algorithm becoming necessary (handled by adding a
  new prefix, never repurposing `"sha256:"`); DDOC or trustless resolution landing, which would
  add a construction for those delivery paths without touching this one; a real score provider
  surfacing a construction defect the frozen vectors did not catch.

## Amendment, 2026-08-27

Review of the first implementation, and then a second adversarial review of the fixes it
prompted, found that **the case/Unicode collision rule this ADR records
as an owner decision was not actually firing**, and that rules the specification required had
never been implemented. Four decisions follow. All were taken *before any pin had been written
to disk* — the one window in which this construction is not yet a one-way door.

**1. The collision key percent-decodes first. (Correction, not a new rule.)**

The decision recorded above — reject a bundle whose paths collide under case folding or Unicode
normalisation — was implemented as "NFC-normalise, then lowercase" applied to the *canonical*
path. But a canonical path is `new URL(...).pathname`, which is **always pure ASCII**: the parser
percent-encodes every non-ASCII byte first. So NFC normalisation was a no-op on every input that
can actually occur, and case folding reached only surviving ASCII. `/%C3%84.js` and `/%C3%A4.js`
(`Ä` and `ä`) were accepted as unrelated, as were the NFC and NFD spellings of one filename, and
— the case that matters — `/.well-known/orivon.json` alongside `/%2Ewell-known/orivon.json`.

That last pair is a **second manifest** reaching the pinned asset set under a single root. Both
decode to one filename in the code cache; whichever wins the write is the manifest whose
capabilities are enforced, while the user consented to a root computed over the other. That is a
widened manifest inheriting a judged identity under an unchanged hash — precisely the failure
this ADR cites as the reason the manifest is a leaf at all, reintroduced through path spelling.

The rule was never wrong; its implementation did not carry it out. `bundle-hash.md`'s collision
key now specifies percent-decoding as the first step, with the worked pairs tabulated.

**2. `Manifest.entry` is checked by the app loader, not by the hash. (Owner decision.)**

The specification's rejection table required refusing a bundle with no leaf at the manifest's
declared entry point; the implementation deliberately did not, since the check means JSON-parsing
untrusted manifest bytes inside an otherwise pure byte-level function. Rather than leave the two
disagreeing — in a document whose stated purpose is bug-for-bug reimplementation by third
parties — the rule is **cut from the hash specification** and stated as an app-loader obligation
(`build-plan.md` step 4), which parses the manifest regardless. An implementation of
`bundle-hash.md` that omits it is conformant.

**3. Vector V5 re-expressed; the vector table is now closed. (Owner decision.)**

V5's inputs were raw supplementary-plane and private-use characters — paths no fetched asset can
present, and which the canonical-form rule (now enforced) refuses. The vector was re-expressed in
percent-encoded form and recomputed by the same independent reference implementation. V1–V4 did
not move; V6 was added, freezing the per-leaf digest table that the pin record persists and that
nothing previously held still.

**This was a one-time exception and it has expired.** Build step 4 writes the first real pin;
from that point no row in the table may be edited for any reason.

**4. The decoded path is validated too, not only the encoded one. (Correction, second round.)**

Adversarial review of the fixes above found they had made half the argument. Decision 1 decodes
percent-escapes to *detect* aliasing; the validator still checked only the encoded string. But
the reason to decode at all is that the decoded form is what becomes a filename — so it is also
the form that must be safe. `/%00.js` and `/..%2F..%2Fevil.js` were canonical, were hashed, and
entered the pinned asset set that this ADR makes the code cache's layout map. Also missed:
`%5C` as a Windows separator, empty path segments, Win32's trailing-dot/space stripping, and
reserved device names.

All are now rejected in the decoded form, **on every platform**, reusing `paths.ts`'s device
list rather than a second one. A rule that fires only on Windows produces a bundle that hashes on
Linux and is refused after download, which is the same has-no-single-identity failure as the
collision case.

The same review found the pin-record reader was more permissive than the bundle validator — it
accepted an empty asset set, a missing manifest leaf, colliding paths and an unbounded count —
and that the record constructor validated a caller's array and then stored it by reference, so
its checks could be undone afterwards. Both closed. **The general rule, now written into
`bundle-hash.md`: the module reading untrusted bytes off disk must never be the laxer of the
two.**

**Consequence worth recording, because this ADR overstated it.** §Reasoning argues at length that
sorting must compare UTF-8 bytes rather than UTF-16 code units. With canonical form enforced,
every path is ASCII, and for ASCII the two orders are identical — so the divergence cannot be
reached, no legal bundle distinguishes them, and V5 no longer demonstrates it. Verified by
mutation: replacing the byte comparator with JavaScript's default sort passes the entire suite.
The comparator is kept (it costs nothing and is correct for any future construction admitting raw
paths), but it is **defence in depth, not a load-bearing rule**. The Unicode risk in this design
lives in the collision key, which is where the actual bug was.
