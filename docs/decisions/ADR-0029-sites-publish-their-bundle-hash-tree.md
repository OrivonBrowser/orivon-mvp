# ADR-0029: Sites publish their bundle hash tree, and the browser shows whether it matches (DDOC)

- **Status:** accepted
- **Date:** 2026-09-24
- **Type:** architecture
- **Decided by:** owner

## Decision

A site publishes the hash tree of its own bundle at `/.well-known/orivon-ddoc.json`: the
`ADR-0009` bundle hash, and the leaf of every file in the leaf set, keyed by canonical path. The
loader fetches it with the bundle and hashes what it received exactly as before. It then keeps
the published tree beside the pin. The Web3 Score page of the site-info popover compares the two
and shows **DDOC** in one of four states:

- **verified**: the published root and every published leaf match the pin;
- **failed**: the tree and the pin disagree, and the page names the files that differ;
- **not published**: the site serves no readable tree;
- **not checked**: nothing is installed for this site.

**None of the four blocks a load.** Whether a failure warns or blocks is the Web3 Score's
decision, not the loader's. In this build the tree is anchored on the site's own host. That
anchor is *provisional*: a record held off the host would settle it.

## Context

The loader computed the bundle hash itself and pinned whatever it received on first use
(`ADR-0005`). The construction is deterministic and specified for reimplementers
(`docs/architecture/bundle-hash.md`), so a Web3 Score provider already computes the same root
from the same files. What nothing carried was the publisher's own statement of which bundle it
means to ship.

The vision's DDOC has this shape: the site owner runs a script that writes the hashes, and the
browser re-hashes what it receives and compares (`native-ddoc-specs.md`). This ADR is that
verification over `ADR-0009`'s bundle. It is not the vision's per-page trees. It does not carry
the vision's DNS record either.

**DDOC does not wait on trustless resolution.** It is the website axis of Trustlessity. Whether a
DNS answer can be trusted is a question for the connection axis, which is scored separately. The
earlier reading of `docs/open-questions.md` A4b tied the two together, and that reading is
withdrawn.

`orivon-ports` builds its apps from static folders. Its port manifests declared no `assets`, so
each port's bundle hash covered two files. The ports tool now generates the `assets` list and
this file from the folder.

## Alternatives considered

**The root inside `orivon.json`.** The manifest is a leaf (`ADR-0009`), so a root cannot sit
inside a file it covers.

**The root in the `<link rel="orivon-manifest">` hint.** The entry HTML is a leaf too, so this is
circular in the same way.

**An HTTP response header.** Static hosts and IPFS gateways cannot set one, and `orivon-ports`
serves static folders.

**Refuse to install when the tree is missing or does not match.** The owner rejected it. The
loader delivers evidence, and deciding what a failure means belongs to the Web3 Score. A refusal
would also give a same-host file a weight it cannot carry: a host able to rewrite the files can
delete the tree too.

**The root alone.** The owner chose the full leaf table, so that a mismatch names the file and a
provider can read every leaf without re-fetching the bundle.

**A DNS record carrying the root.** This is the vision's anchor. Because it sits off the host, it
is the part that catches a host whose files and tree were both rewritten. It is left out of this
change for scope, and when it arrives the file format does not change: the record carries the
same root.

**Per-page trees, or a Merkle tree.** `ADR-0009` already rejected a tree shape. The vision's page
trees list what a page is observed to load at runtime, while this bundle is the static, declared
set (`ADR-0011`).

## Reasoning

The construction is unchanged, so there is nothing new for a provider to reimplement. The tree
proves one thing: the files this browser pinned are the files the site's host publishes a tree
for. That catches:

- a half-finished deploy;
- a CDN or mirror serving a mix of two releases;
- a single file altered on a host whose tree was not also rewritten.

It does not catch a host compromised well enough to rewrite both the files and the tree. The
popover says only what was compared ("files match the hash tree this site publishes"), never who
owns the domain.

The verdict is computed against the current pin, every time the popover opens. A tree stored for
an earlier bundle can therefore only fail, never verify. A verified root beside a wrong leaf
table still fails, because a provider reading the table would be misled.

The delivery ladder is unchanged: D2 still grades how the bundle was pinned (`ADR-0006`).

## Consequences

- **The file format is a publisher contract**, specified in `bundle-hash.md` §Where a publisher
  declares it: the path, the JSON shape, the parse rules and the size cap. Anything that fails to
  parse counts as not published.
- **The loader fetches the tree after the manifest, and never after a 304.** It stores the tree
  as `ddoc.json` beside `pin.json`, and removes the old one before writing a new pin, so an
  install interrupted between the two reads as not published. Failing to store the tree never
  fails an install.
- **A manifest's `assets` may not name the manifest or the tree.** `parseManifest` refuses both.
- **A dev origin is never installed, so its DDOC reads "not checked".** Ported apps run that way
  in this build.
- **A release that changes only files is not seen** when the manifest answers 304 (A236), so its
  tree is not fetched either. Comparing the published root with the pin could replace that check.
- **Nothing acts on a failure yet.** The Web3 Score doing so is separate work.
- `ADR-0005`'s "hash-pinning as the sole integrity mechanism" and `ADR-0006`'s deferral of DDOC
  are amended in place.

## Reversibility

- **Cost to reverse:** moderate. Once tools write the file (`orivon-ports` does), its path and
  shape are a contract with every publisher. The verdict and its wording are cheap to change, and
  an off-host anchor can be added without changing the file.
- **What would make us revisit:** an off-host record carrying the root being built; or a Web3
  Score provider that needs the tree signed.
