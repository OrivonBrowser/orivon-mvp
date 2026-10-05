# `src/loader/fetch/`: turning a hint into a validated bundle

**What lives here.** `bundle.ts` (`fetchBundle`, the orchestration), `asset.ts` (the one-asset
fetch and the bounded pool), `budget.ts` (the `Fetch` type, byte cap and idle deadline),
`install-origin.ts` (T12/A46's public-unicast guard), `verifier-origin.ts` (the hosts a protocol
serves, exempt from that guard and given a longer idle deadline), `content-root.ts` (the root-CID
request header), `update-check.ts` (the update-check interval and conditional-request validators),
`undeclared-assets.ts` (warning about subresources the manifest doesn't declare) and
`manifest-at-root.ts` (the manifest of the content a root CID names, and nothing else of the bundle).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../manifest/`](../manifest/)
and [`../ddoc-declaration.ts`](../ddoc-declaration.ts). Value imports run one way into
[`../cache/`](../cache/) (`bundle.ts` reads `LoaderStorage`'s type); `cache/install.ts` imports
`undeclared-assets.ts` back, so the two folders depend on each other in both directions at this
one seam.

**What it must never import.** [`../../shim/`](../../shim/), as the parent README says.

## Design notes

The install-origin guard, the fetch pool and its deadlines, the same-origin redirect rule, a
root `entry`, HTML served in place of a script, and the undeclared-file warning are each
documented where they are enforced: `install-origin.ts`, `asset.ts`, `budget.ts` (the `Fetch`
type), `../electron/fetch.ts`, `../manifest/manifest.ts` and `undeclared-assets.ts`.

**[`bundle.ts`](bundle.ts) owns one concern**: `(fetch, hintedUrl)` in, a validated bundle out.
TOFU versus `decideUpdate()` is `../index.ts`'s job, and persistence is
[`../cache/install.ts`](../cache/install.ts)'s.

**There is no `assetPaths` parameter anywhere in this directory.** `fetchBundle` reads the file
list off the manifest (`entry` unioned with `assets`,
[`ADR-0011`](../../../docs/decisions/ADR-0011-manifests-declare-their-own-asset-list.md)), since
only it knows the well-known path: a caller of `load()` has nothing but `hintedUrl`. `entry` is
always fetched, because the entry-leaf check needs it.

**Some of `bundle.ts`'s checks are unreachable through the public API, on purpose.** They stay as
defence in depth, in case the computation they guard ever drifts:

- a hostile asset list (a cross-origin URL, path traversal, a case-fold collision, too many
  entries): `../manifest/manifest.ts` refuses each shape first, so the coverage is in
  [`../manifest/tests/manifest.test.ts`](../manifest/tests/manifest.test.ts);
- the entry-leaf check (`ADR-0009` amendment #2): `entryPath` and the asset loop's canonical path
  are the same computation for the entry;
- `bundleTree()`'s case-folding collision check, covered directly in
  [`bundle-hash.test.ts`](../../broker/policy/tests/bundle-hash.test.ts).

A redirect cannot land two declared names on one path either: every asset is pinned under the
url it requested, never `response.url` (A141).

**An installed app is checked for an update at most once an interval, and an unchanged app costs
one small request.** The last check's time is kept per origin
([`update-check.ts`](update-check.ts)), so a restart does not reset it. A 304 always means "the
manifest you have pinned": its validators are stored with the pinned manifest's leaf and sent
only while the pin still holds it. **What this assumes of a publisher:** every release changes
the manifest, at least its `version`; files changed under a byte-identical manifest are not
picked up (A236). A cache that fails verification at start forgets its record, so the next visit
checks, and heals, in full.
