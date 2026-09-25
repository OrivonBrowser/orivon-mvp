# ADR-0034: `src/preload/`, `src/shim/`, `src/verifier-host/`, `src/loader/` and `src/broker/` are organised by job, on one naming rule

- **Status:** accepted
- **Date:** 2026-09-25
- **Type:** architecture
- **Decided by:** owner

## Decision

Five flat directories are reorganised into job-named subfolders, on the naming convention
[`ADR-0015`](ADR-0015-the-broker-is-organised-by-job.md) established for `src/broker/` and
[`ADR-0023`](ADR-0023-src-main-is-organised-by-job.md) extended to `src/main/`: name a folder
for the job it does, declare what it depends on and must never import, carry a `README.md`.

| Directory | New folders |
|---|---|
| `src/preload/` | `surface/` (the `orivon.*` page surface), `ports/` (the isolated-world socket state machines), `routed/` (ADR-0017's ten routed-network installers) |
| `src/shim/` | `fs/`, `net/` (also `tls`, `dgram`, `dns`), `http/`, `polyfills/` (the eight core polyfills and their hand-written siblings) |
| `src/verifier-host/` | `light-client/`, `serve/` (the loopback TLS server) |
| `src/loader/` | `manifest/`, `fetch/`, `cache/`, `serve/`, `reach/` (the third-party reach path), `electron/` |
| `src/broker/` | `capabilities/` (the sixth job alongside `policy/`/`grants/`/`handles/`/`adapters/`/`transport/`), and `transport/` splits into `dispatch/` and `relay/` |

**A file's path is part of its name, so a moved file drops the words its new folder already
says.** `src/loader/serve-csp.ts` becomes `src/loader/serve/csp.ts`; `src/shim/node-fs.ts`
becomes `src/shim/fs/fs.ts`. A file with nothing left to drop takes the folder's own name
(`src/loader/serve-reach.ts` becomes `src/loader/reach/reach.ts`). Four renames go one step
further than the rule, to fix a name the rule alone would have kept wrong or ambiguous:

- `src/shim/node-http-errors.ts` becomes `src/shim/node-errors.ts`, not `src/shim/http/errors.ts`:
  the file's own header already states it is the package-wide Node error mapper, shared by `fs`,
  `net`, `http`, `dgram` and `dns` alike, so filing it under `http/` would misname what it is.
- `src/shim/node-fs-path.ts` becomes `src/shim/fs/paths.ts`, not `fs/path.ts`: `fs/core.ts`
  imports both this file and the bare `'path'` package in the same file, and the rule's own
  output would have collided.
- `src/preload/fetch-route-types.ts` becomes `src/preload/routed/types.ts`, not `fetch-types.ts`:
  all ten routed installers use it, not only `fetch.ts`.
- `src/loader/tests/manifest-caps.test.ts` becomes `src/loader/manifest/tests/size-caps.test.ts`,
  not `caps.test.ts`: it tests `MAX_MANIFEST_BYTES`, a byte cap, and sitting inside `manifest/`
  next to `capabilities.test.ts` the bare rule's output would have read as testing capabilities.

A file used across more than one of a directory's new folders stays at that directory's own top
level rather than picking one folder to belong to: `src/loader/leaf-hash.ts` and
`ddoc-declaration.ts` (fetch, cache and serve all use them), `src/preload/orivon-error.ts` (the
page surface and the ports both use it, and putting it in either would cycle), `src/broker/`'s
five `*-contracts.ts` files and `errors.ts`/`io-errors.ts` (imported as values by `src/main/`, so
moving them costs every importer a path edit for no reason).

`src/main/` is not touched by this ADR and keeps [`ADR-0023`](ADR-0023-src-main-is-organised-by-job.md)'s
existing names (`app-install.ts`, not `install/app.ts`); [`A257`](../open-questions.md) asks
whether it should adopt this ADR's naming rule later.

## Context

Four of the five directories were flat, with only a shared filename prefix
(`serve-reach-*`, `node-fs-*`, `websocket-route-*`) grouping their parts: 36 files in
`src/loader/`, 32 in `src/preload/`, 59 in `src/shim/`. `src/broker/` had used job folders since
ADR-0015, but 17 files had built up loose at its top level and `transport/` had grown from the
nine files that ADR counted to 26 — past the split ADR-0015's own §Reversibility predicted.
`src/verifier-host/` was flat too, at 13 files. The problem is the one ADR-0015 and ADR-0023
already named: a flat directory hides which files decide a question, which move bytes, and which
are types, and a reader has no way to tell from the file list alone.

This ADR exists because [`CLAUDE.md`](../../CLAUDE.md) Rule 1 asks that a load-bearing choice
reversible only at cost be written down. The layout qualifies the same way ADR-0015's and
ADR-0023's did: it asserts a decomposition of five subsystems, and reversing it means another
whole-repository move with every path reference rewritten again.

**Scope, stated plainly (CLAUDE.md Rule 4).** This is a repository-wide sweep across five
streams' paths, landed on one branch rather than five. That is the carve-out
[`open-questions.md`](../open-questions.md) A24 asks whether a repo-wide sweep should be exempt
from the one-stream-per-branch rule; the owner chose it here, recorded as
[`d-0119`](decision-log.md).

## Alternatives considered

**Keep the flat layout, add a file-map table.** Rejected for the reason ADR-0015 and ADR-0023
both already gave, and the repository has independent evidence for it beyond either: the comment
budget is enforced in CI precisely because a hand-followed rule drifted anyway. A map maintained
by hand next to the thing it maps is the same bet a third time.

**Keep the repeated prefix** (`loader/serve/serve-csp.ts`, not `loader/serve/csp.ts`). This is
what ADR-0015's own broker layout did (`policy/connect-patterns.ts`, not `policy/patterns.ts`).
Rejected here on the owner's explicit call: a file's path is part of its name, and `serve/csp.ts`
reads its folder for free where `serve/serve-csp.ts` repeats it. The cost, accepted: four names
need the "drops nothing" exception above, and a handful of doc mentions read slightly less
self-contained out of context (`csp.ts` alone, versus `serve-csp.ts` alone) — mitigated by
writing every doc mention with its folder, `serve/csp.ts`, not the bare filename.

**Do the five directories as five separate branches and PRs, matching the ownership map's
existing stream split.** ADR-0015's and ADR-0023's own broker/main moves were each single-
directory changes on their owning stream's branch. Rejected here because the five directories
this ADR covers are not independently owned in the same way: `src/preload/`'s `surface/` and
`ports/` are `broker`-owned files sitting in a directory `shell` also touches, and the codemod
proving each move (see Reasoning) is the same mechanism reused five times, not five different
pieces of work. Landing them separately would mean re-syncing four more times against a moving
`main` for no benefit; A24's carve-out exists for exactly this shape of change.

## Reasoning

The decomposition is not invented for the filesystem, the same claim ADR-0015 and ADR-0023 make:
every file in each of these five directories already did exactly one job, and the flat listing
simply refused to say which. `src/loader/`'s `serve-reach-*.ts` files were already the third-party
reach path in every sense but their folder; `src/shim/`'s `node-http-*.ts` files were already
`http`/`https`'s own implementation. Naming the folder after the job the files already shared
makes the tree teach the decomposition instead of requiring a document to.

**A codemod did the mechanical part, proven directory by directory before being trusted on the
next.** Every move (`git mv` plus rewriting every relative import, `vi.mock` target, and
repo-rooted string reference) was validated on a disposable local clone first — typecheck, the
full test suite compared against a recorded baseline count, and all eleven `check:*` guards —
before being applied to the real branch, then verified there again. A small number of references
the codemod correctly could not resolve on its own (a bare mention missing its `src/` prefix, a
glob pattern in a doc string, two comments that had already drifted to the wrong `../` depth
before this move) were found by an exhaustive `git grep` sweep for every old filename afterward
and fixed by hand. The result: 445 files changed, 256 of them git-recognised renames, across six
commits, with the test suite passing at the identical count before and after each one.

## Consequences

**Committed to:** sixteen new `README.md` files, one per new folder, each stating what it
depends on and must never import, plus the naming rule above. A file whose job changes has to
move, and a dependency that stops holding has to be corrected in the README rather than quietly
violated.

**The unpleasant part, stated plainly, the same as ADR-0015's and ADR-0023's:** the boundaries
are prose. Nothing mechanically stops `src/loader/reach/reach.ts` from importing `electron`
tomorrow, the one rule its own README states. That gap is `A85`, already open for `src/broker/`
and `src/main/`, now covering these five directories' new folders too.

**`src/main/` now has one different naming convention from the other five reorganised
directories**, since it keeps ADR-0023's own names rather than adopting this ADR's "drop the
repeated words" rule. `A257` records the question rather than answering it here: extending the
rule to `src/main/` is a decision of its own size, not a natural extension of this one.

## Reversibility

- **Cost to reverse:** expensive. Another whole-repository move, with every import specifier,
  `vi.mock` target and documentation link rewritten again. Not a one-way door: no behaviour
  depends on the layout, and the codemod that did the forward move is reusable for the reverse
  one.
- **What would make us revisit:** a new folder that stops answering one question on its own —
  most likely `src/loader/fetch/`, at eight files the largest of the new folders here, the same
  size `src/broker/transport/` was when ADR-0015 first counted it as needing to stay whole.
