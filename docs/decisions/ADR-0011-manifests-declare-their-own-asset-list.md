# ADR-0011: Manifests declare their own asset list

- **Status:** accepted
- **Date:** 2026-09-03
- **Type:** architecture
- **Decided by:** owner

## Decision
`Manifest` gains an explicit field, `assets: readonly string[]`, naming every frontend file that
makes up the app's leaf set — the same set `ADR-0009`'s bundle hash is computed over. The
publisher declares this list; the loader never infers it. An app's frontend that later fetches or
loads additional files or code of its own accord is not this field's concern — that behaviour is
judged after the fact by the trust/Web3-Score system (`ADR-0006`), not predicted or enumerated
up front by the manifest.

## Context
`docs/open-questions.md` A45. `ADR-0009` and `docs/architecture/bundle-hash.md` both assume a leaf
set is already in hand — they specify how to hash one, never how to obtain one — and
`src/loader/index.ts`'s `createLoader().load()` was built taking that set as an injected parameter
specifically because nothing decided where it should come from. `Manifest` as it stood named only
`entry`, the one HTML file; nothing named the rest of a real app's frontend, which for any built
SPA (the tier-1 Nostr web clients `app-compatibility.md` pins "as-is") is routinely dozens of
JS/CSS/asset files.

## Alternatives considered
**A crawl heuristic** — fetch `entry`, parse it for same-origin references
(`<script src>`/`<link href>`/`<img src>`, recursing into fetched CSS/JS), and build the set from
what is found. Rejected: it is a content-parsing surface over adversarial input running before any
capability has been granted, it cannot see anything referenced only at runtime (a dynamic
`import()`, a service-worker `fetch()`), and — the decisive reason — the discovered set feeds
directly into `ADR-0009`'s bundle hash, which is a one-way door once the first pin exists. Two
independent implementations of "what counts as this app's content" that disagree would disagree
about the app's own identity, the exact class of problem `ADR-0009`'s own amendment record already
had to close once for the hash construction itself. A heuristic is also strictly worse for the
Web3-Score model this ADR leans on: a provider re-verifying a bundle would have to reproduce the
crawl exactly, byte for byte, rather than simply re-fetching a declared list.

## Reasoning
The manifest already declares capabilities the same way — statically, explicitly, publisher-owned
(`capability-api.ts`'s design rule 4: "declare statically, grant dynamically"). An asset list is
the same shape of fact about the same document, not a new kind of thing for a publisher to
maintain. It keeps the loader's job over the declared set purely mechanical: fetch under the byte
caps, hash, pin, done — with no code path that inspects a fetched file's contents to decide
whether it belongs to the app.

The genuine cost — a publisher must keep this list in sync with what they actually ship — is
deliberately not compensated for here, because the compensating mechanism already exists one
layer up: if an app's own code goes on to load a materially different set of resources than what
was declared and hashed, that is exactly the kind of undisclosed behaviour the trust/Web3-Score
system (`ADR-0006`) is built to notice and score down, not something the manifest format needs to
prevent by trying to enumerate every possible resource in advance. Static declaration bounds what
gets a TOFU'd identity and a permission prompt; the score bounds what a page can get away with
afterward. Splitting the concern this way keeps each mechanism doing the one thing it can actually
verify — the manifest can verify a list matches what was fetched; it cannot verify that a list is
*complete*, and should not pretend to.

## Consequences
- `src/contracts/manifest.ts`: `Manifest` gains `readonly assets: readonly string[]`, alongside
  `entry`. Contracts-only change, its own PR, merges before anything below depends on it.
- `src/loader/manifest.ts`'s `parseManifest` validates it the same way other manifest fields are
  validated (structurally sound array of canonical-path-shaped strings; the existing per-path
  canonical-path validator, `src/broker/policy/canonical-path.ts`, is reused, not duplicated).
- `src/loader/index.ts`'s `createLoader().load()` keeps taking `assetPaths` as an explicit
  parameter — this ADR does not change that function's shape. What changes is where the caller
  gets the value: read off `manifest.assets` after `parseManifest` succeeds, rather than the
  caller inventing or discovering it. `docs/open-questions.md` A45 is resolved by this ADR, cited
  from its own entry.
- `entry` itself is unchanged and still separately required to have a corresponding leaf
  (`ADR-0009`'s amendment §2: checked by the app loader, not the hash) — `assets` does not need to
  duplicate `entry` in its own list; the loader fetches the union of the two.
- No change to `ADR-0009`'s hash construction, `bundle-hash.ts`, or any frozen vector. The leaf
  set's *source* changes; nothing about how a leaf set is hashed does.

## Reversibility
- **Cost to reverse:** moderate before any app has shipped a manifest declaring `assets`;
  expensive afterward, for the same reason changing what counts as "the leaf set" is always
  expensive once a real pin references one (`ADR-0009`). Switching to a crawl heuristic later
  would need every existing declared-asset manifest to keep working un-migrated, or a version gate.
- **What would make us revisit:** real publishers finding the declared list an unworkable
  maintenance burden in practice (not merely a theoretical one), or the trust/Web3-Score system
  turning out not to actually catch the undisclosed-resource case this ADR leans on it for.
