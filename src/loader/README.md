# `src/loader/` — the app loader

**What lives here.** Manifest discovery at `/.well-known/orivon.json`, asset fetch and cache,
per-version hash pinning, and the update decision (silent / re-consent / capability prompt /
reject).

**What it depends on.** [`src/contracts/`](../contracts/) and [`src/broker/`](../broker/)
(for storage and the grant ledger).

**What it must never import.** [`src/shim/`](../shim/).

**Owner stream.** `loader` — build step 4.

**Never probe automatically.** An unsolicited request to every origin the user visits is an
active, attributable *"this visitor runs Orivon"* signal, sent from a privacy-branded browser.
Discovery is a `<link rel="orivon-manifest">` hint in HTML already delivered — the only
trigger; there is no separate user action, a Web3site is the URL, not a thing to convert a
website into (`capability-api.md`'s 2026-09-03 correction). The well-known path is fetched
**only after** seeing that hint.

**The install origin's hostname must resolve as public-unicast before that fetch, no exception**
([`install-origin.ts`](install-origin.ts), T12/A46). This is the shell itself, unsandboxed,
making the very first request — with no grant and no manifest yet to gate it — so a hint pointing
at a loopback, private, link-local or cloud-metadata address is refused outright, even the
loopback case `docs/open-questions.md` A46 otherwise permits for a *user-typed* address: the only
discovery trigger here is a page-supplied hint, which is exactly the provenance A46 says loopback
must never be reachable from.

**The update decision is where a silent failure is a security failure.** Its failure mode is
"no prompt appeared", which no manual checklist catches, and the capability at stake is
`tcp.connect *:*`. Re-consent triggers on a **subset check over the granted pattern set**, not
on capability kinds — see [`capability-api.md`](../../docs/architecture/capability-api.md) A9 §2.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why [`fetch-bundle.ts`](fetch-bundle.ts) is its own file, not part of `index.ts`.** Split out
per [`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 2 — it owns exactly
one concern: turning `(fetch, hintedUrl)` into a validated bundle. TOFU versus `decideUpdate()`
branching, and persistence, are `index.ts`'s job, not this file's.

**Corrected 2026-09-04 -- `assetPaths` is no longer a parameter anywhere in this directory; the
two paragraphs below describe what replaced the design this section used to document.**
`fetchBundle` reads the app's file list off the manifest itself (`manifest.entry` unioned with
`manifest.assets`, [`ADR-0011`](../../docs/decisions/ADR-0011-manifests-declare-their-own-asset-list.md))
once it has fetched and parsed it -- never supplied by a caller. `ADR-0011`'s own Consequences
section originally kept `assetPaths` as an explicit parameter to `Loader.load()`, on the
assumption that whatever eventually wires the discovery trigger would fetch the manifest itself
first and pass the resulting list in. That assumption doesn't hold: the well-known manifest path
is fixed and known only to `fetchBundle` itself (this file's own header, above), so nothing
external ever has a parsed manifest to read `assets` off *before* calling `load()` -- the caller
of `load()` only ever has `hintedUrl`, the same thing a passive hint listener has. See
`ADR-0011`'s own amendment for the full account.

`entry` is unioned into the fetched set unconditionally, not only when convenient -- it is a leaf
of the bundle like any other declared asset, and the entry-leaf check needs it fetched to find
it. One consequence worth knowing if you're reading `fetch-bundle.ts` next to its tests: several
checks that used to guard against a hostile *caller-supplied* `assetPaths` array (an absolute
cross-origin URL, a path-traversal string, two names that collide under case-folding, too many
entries) are now unreachable through the public two-argument API, because `manifest.ts`'s own
validation (`readAssets`/`validateRelativePath`/`MAX_ASSETS`) already rejects every one of those
shapes before `fetchBundle` ever sees them -- one layer earlier than before. Those checks are
still in `fetch-bundle.ts`, kept as defence in depth rather than removed (this function must not
quietly start trusting that `manifest.ts`'s validation is airtight), but their dedicated test
coverage moved to [`manifest.test.ts`](manifest.test.ts), which already exercised the same input
shapes independently. What `manifest.ts` cannot see -- a *redirect* landing two distinct declared
names, or a redirected entry, at the same or a different canonical path than declared -- remains
directly tested here, since only a real fetch can produce it.

**Why [`install-origin.ts`](install-origin.ts) is its own file.** Split out of `fetch-bundle.ts`
per Rule 2 (adding the T12/A46 guard pushed that file to 524 lines) — it owns exactly one
question, "may this hostname be installed at all," independent of everything else `fetchBundle()`
does once that question is answered. Tested through `fetch-bundle.test.ts` rather than a file of
its own, the same way `manifest-capabilities.ts` is tested through `manifest.test.ts` — it has no
caller-visible contract beyond what `fetchBundle()` already exercises.

**Why `pruneAssets` compares folded paths, and why folding is the safe direction.**
[`node-storage.ts`](node-storage.ts) decides what to delete by comparing the manifest's declared
asset paths against what `readdir` reports on disk. Two spellings of one filename break that
comparison in two ways, and both were real. APFS and HFS+ store a non-ASCII filename decomposed
(NFD) even when the bytes written were precomposed (NFC, the form a JSON manifest normally
carries). APFS and NTFS are also case-insensitive but case-preserving, so a bundle update that
changes only an asset path's case rewrites the *same* physical file while `readdir` keeps
reporting the original spelling. Both are supported run-from-source targets
([`CLAUDE.md`](../../CLAUDE.md) Rule 8). Both sides of the comparison therefore go through
`canonical-path.ts`'s `foldForIdentity` (NFC, then case-fold) -- the same folding
`collisionKey` applies, minus its percent-decode step, which would corrupt a literal `%` in an
already-decoded real filename.

Folding case is deliberately *more* permissive than a genuinely case-sensitive filesystem is:
`/App.js` and `/app.js` are two files on ext4 and would now be treated as one. That is the
direction to err in for a delete. Reading two files as one leaves a stale file on disk, which is
disk hygiene; reading one file as two deletes a live asset the app needs, which is data loss.

**Why an empty directory is only removed when this prune emptied it.** Nothing in the loader
removed a directory at all before pruning existed, so the write path (`mkdir` then `writeFile`)
never had to survive a directory disappearing under it. A sweep of every empty directory under
the code root would reintroduce exactly that: a concurrent install's `mkdir` for a new
subdirectory, not yet written into, looks indistinguishable from a leftover
([`open-questions.md`](../../docs/open-questions.md) A62). So `removeEmptyAncestors` climbs only
from directories this prune deleted a file from. The cost is that a directory left empty by an
interrupted earlier run survives until a prune deletes from it again.

**Why a fresh install does not prune.** `install()` skips `pruneAssets` on the TOFU path: no
earlier pin exists for that origin, so there is nothing a previous bundle could have left behind,
and the walk would only re-read every file the write loop just wrote -- one `realpath` per
declared asset, up to `MAX_BUNDLE_ENTRIES` of them. The one state this gives up on is an origin
whose `code/` tree survived while its pin record did not (a crash between the two writes): those
files are not swept by the re-install that follows, but the re-install does write a pin, so the
next update prunes them.
