# `src/loader/cache/`: writing and pruning what's on disk

**What lives here.** `storage.ts` (the `LoaderStorage` interface), `node-storage.ts` (the
`node:fs` implementation) and `install.ts` (commits staged files, pin and DDOC).

**What it depends on.** [`../../contracts/`](../../contracts/),
[`../ddoc-declaration.ts`](../ddoc-declaration.ts) and [`../leaf-hash.ts`](../leaf-hash.ts).
`install.ts` imports [`../fetch/undeclared-assets.ts`](../fetch/undeclared-assets.ts);
`../fetch/` imports only this folder's types back, so the value dependency between the two runs
one way, through `install.ts`.

**What it must never import.** [`../../shim/`](../../shim/), as the parent README says.

## Design notes

An install writes only the files whose bytes on disk differ, each by one atomic rename
(`install.ts`'s `install`, `node-storage.ts`'s `writeAtomically`). Pruning compares paths folded
for macOS and Windows spellings and removes only directories it emptied itself
(`node-storage.ts`'s `pruneAssets` and `removeEmptyAncestors`). A crash part-way through an
install recovers as [`../electron/README.md`](../electron/README.md) describes under "When the
cached bundle fails verification".

**Why an install never prunes: the next start does.** A single-page app still running the
previous bundle lazily `import()`s its old hashed chunks, and pruning at install turned each into
a 404. Superseded files stay on disk and servable for the rest of the process
(`../electron/serve.ts`'s `retainedAssets`), each checked against the leaf it was pinned with,
once per file identity ([`../serve/asset.ts`](../serve/asset.ts)). A path both pins declare is
overwritten, so only its new bytes exist: the entry document and any unhashed file, which the
reload fetches anyway. `restorePinnedServing` prunes to the verified pin, and clears any staging
a crash left, at the next start, before any page can still need the old files.
