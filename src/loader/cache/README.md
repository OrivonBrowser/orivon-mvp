# `src/loader/cache/`: writing and pruning what's on disk

**What lives here.** `storage.ts` (the `LoaderStorage` interface), `node-storage.ts` (the
`node:fs` implementation) and `install.ts` (commits staged files, pin and DDOC).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../ddoc-declaration.ts`](../ddoc-declaration.ts)
and [`../leaf-hash.ts`](../leaf-hash.ts). `install.ts` imports
[`../fetch/undeclared-assets.ts`](../fetch/undeclared-assets.ts); `../fetch/` imports only this
folder's types back, so the value dependency between the two runs one way, through `install.ts`.

**What it must never import.** [`../../shim/`](../../shim/) -- see the parent README's "What it
must never import".

**Owner stream.** `loader`, build step 4.

## Design notes

**An install writes only what changed, one atomic rename per file, and a crash heals itself.**
[`install.ts`](install.ts) compares each staged leaf with a streaming hash of the file already in
`code/` at that path and commits (renames) only those that differ; an unchanged bundle writes
nothing at all and keeps its pin record, so a repeat visit leaves the cache untouched. Every
write is a rename from staging (`node-storage.ts`'s `writeAtomically`, `commitStaged`), so a
reader sees the old file or the new one, never a partial one (A62's second half). Comparing
against the bytes on disk, not the old pin's leaf, is what lets a damaged cache heal: a file that
no longer matches is rewritten even when its pinned leaf did not change. A crash part-way through
leaves some files new and the old pin in place; the next start's verification then fails and the
app recovers as described under "When the cached bundle fails verification" in
[`../electron/README.md`](../electron/README.md).

**Why `pruneAssets` compares folded paths, and why folding is the safe direction.**
[`node-storage.ts`](node-storage.ts) decides what to delete by comparing the manifest's declared
asset paths against what `readdir` reports on disk. Two spellings of one filename break that
comparison in two ways, and both were real. APFS and HFS+ store a non-ASCII filename decomposed
(NFD) even when the bytes written were precomposed (NFC, the form a JSON manifest normally
carries). APFS and NTFS are also case-insensitive but case-preserving, so a bundle update that
changes only an asset path's case rewrites the *same* physical file while `readdir` keeps
reporting the original spelling. Both are supported run-from-source targets
([`CLAUDE.md`](../../../CLAUDE.md) Rule 8). Both sides of the comparison therefore go through
`canonical-path.ts`'s `foldForIdentity` (NFC, then case-fold), the same folding
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
([`open-questions.md`](../../../docs/open-questions.md) A62). So `removeEmptyAncestors` climbs only
from directories this prune deleted a file from. The cost is that a directory left empty by an
interrupted earlier run survives until a prune deletes from it again.

**Why an install never prunes: the next start does.** An update can land while the app is open,
and a single-page app still running the previous bundle lazily `import()`s its old hashed chunks;
pruning at install turned each of those into a 404 and a `ChunkLoadError`. So
[`install.ts`](install.ts) leaves every superseded file on disk, and `../electron/serve.ts` keeps
serving them for the rest of the process: `registerServingFor` remembers every path each pin it
served declared (`servedAssets`) and hands the new handler the ones the new pin dropped
(`retainedAssets`), which [`../serve/path.ts`](../serve/path.ts) resolves and
[`../serve/asset.ts`](../serve/asset.ts) serves only after checking the file still hashes to the
leaf it was pinned with. That check reads the whole file, so its verdict is kept per file identity
(size, modification time and inode, read from the same open handle the bytes are served from)
and pinned leaf: a retained chunk is hashed once, not on every request, and a file rewritten on
disk gets a new identity and is checked again. A path both pins declare is overwritten, so only the
new bytes exist; that is the entry document and any unhashed file, which the reload fetches anyway.
`restorePinnedServing` prunes to the verified pin, and clears any staging a crash left, at the
next start, before any page can still need the old files.
