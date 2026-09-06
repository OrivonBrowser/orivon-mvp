# ADR-0015: The broker is organised by job, and each directory declares what it may not import

- **Status:** accepted
- **Date:** 2026-09-06
- **Type:** architecture
- **Decided by:** owner

## Decision

`src/broker/` is organised into five directories named for the **job** each does, not for the
kind of file each holds. Every one of them carries a `README.md` declaring what it depends on
and **what it must never import**, and those declarations are part of the design rather than
commentary on it:

| Directory | Job | Holds state? | Touches I/O? |
|---|---|---|---|
| `policy/` | **Decide** — may this origin do this? | no, pure functions | **never** |
| `grants/` | **Remember** — what did the user approve? | yes, per origin | disk, for persistence |
| `handles/` | **Hold** — what is this origin holding, and can I take it back? | yes, per origin | **never**, `destroy` is injected |
| `adapters/` | **Do** — dial the address, open the file | no | this is where real I/O happens |
| `transport/` | **Speak** — reach the page, move the bytes | connection registry | Electron IPC and ports |

`index.ts`, `broker-contracts.ts` and `errors.ts` stay at the top level because they belong to
no single one of them. Tests live in a `tests/` folder **inside** the directory they cover.

## Context

`src/broker/` held 83 TypeScript files across two flat directories, 40 of them tests
interleaved alphabetically with the source. The owner's stated problem was not aesthetic:
*"creates disorder and makes it harder to audit for a human who does that work."*

Flatness hid the thing most worth seeing. `grant-ledger.ts` sat between `errors.test.ts` and
`handle-contracts.ts` with nothing signalling that one of the three is a state machine, one is
a type file, and one is a test. A reader had no way to tell, from the file list alone, which
files decide security questions and which move bytes.

This ADR exists because [`CLAUDE.md`](../../CLAUDE.md) Rule 1 asks that a load-bearing choice
that is reversible only at cost be written down rather than absorbed silently. The layout
qualifies on both counts: it asserts a decomposition of the subsystem, and reversing it means
another whole-subsystem move with every path reference rewritten again.

## Alternatives considered

**Keep the flat layout, add a file-map table to the README.** Zero risk and zero staleness, and
it was seriously considered. It lost because it does not reduce what a reader scrolls past, and
because this repository has direct evidence that such a document drifts: the comment budget is
enforced in CI precisely because "the rule was being followed and the codebase drifted anyway"
([`code-guidelines.md`](../development/code-guidelines.md)). A map maintained by hand next to
the thing it maps is the same bet, made again.

**Split by audit surface — `core/` versus `plumbing/`.** Two directories: what a security
auditor must read, and what they may skim. Rejected, and worth recording why, because it is the
option that sounds most aligned with the goal. The dividing line is a judgement call, and a
file placed on the wrong side becomes *hidden* from audit rather than merely misfiled — a worse
failure than clutter, and a silent one. `transport/ipc.ts` is the case that kills it: by shape
it is plumbing, but it is where the origin is derived from `senderFrame` (T3), which is the
single most security-critical decision in the subsystem. Any scheme that files that under
"plumbing" actively misleads the reader it was built for.

**Promote `policy/` to `src/policy/`.** Defensible on the facts — `src/loader/` already imports
eight of its modules across nine files, so the current path understates what it is. Not taken
here because it is a different decision, about ownership and change control rather than
legibility: it would make `policy/` a second change-controlled directory with two consumer
streams. Left open; taking it later does not conflict with this ADR.

**Separate tests into a top-level `test/broker/`.** Rejected in favour of per-directory
`tests/` folders, so that reading a directory shows that directory's tests and nobody else's.

## Reasoning

The decomposition is not invented for the filesystem — it is the one the subsystem already had
and did not show. Every source file already did exactly one of decide / remember / hold / do /
speak; the flat directory simply refused to say which.

Naming the directories after the jobs makes the tree teach the decomposition instead of
requiring a document to. The boundary declarations then do the load-bearing work: they were
**read off the real import graph rather than asserted**, and two of them turned out to be worth
committing to. `handles/` imports no `node:*` builtin at all — every real resource arrives as an
injected `destroy` callback, which is what keeps the revocation cascade testable with no network
and no Electron. `adapters/` is where a real address is dialled or a real path is opened, which
gives an auditor asking *"what can this program reach?"* a place to start rather than a search.

It also makes the next required change natural instead of awkward. `handles/handles.ts` sits at
491 lines against the 500-line limit, and `CLAUDE.md` already records that the next addition to
it needs a split. Inside a `handles/` directory that split is obvious; at the top level it would
have been another loose file.

## Consequences

**Committed to:** five directories whose names are a claim about what the code does, and five
README files that must stay true. A file whose job changes has to move, and a boundary that
stops holding has to be corrected in the README rather than quietly violated — the failure mode
this replaces was one where nothing could be violated because nothing was claimed.

**The unpleasant part, stated plainly:** the boundaries are prose. Nothing mechanically stops
`handles/` importing `node:fs` tomorrow. That gap is filed as `A85`, deliberately not built in
the same change that created the layout — a guard written the same hour as the rule tests the
author's assumptions rather than the rule's staying power.

**A known imperfection, recorded rather than smoothed over.** `grants/node-ledger-storage.ts`
is the one file that makes the table above need a footnote: it lives in `grants/` because its
subject is permissions, but it writes to disk, so "`adapters/` is where I/O happens" is true of
intent rather than of every file. The owner was offered the alternative — group it by what it
does rather than what it is about — and kept it with `grants/`. If a second Node-backed store
lands in `grants/`, that is the trigger to revisit.

**Cross-stream cost, paid once.** Renaming paths in a repository whose comments are its
documentation touched 227 references across source and docs. That is the recurring tax on any
future move of this kind, and it is the main reason the cost to reverse is what it is.

## Reversibility

- **Cost to reverse:** expensive — another whole-subsystem move, with every import specifier,
  comment reference and documentation link rewritten again (92 files this time). Not a one-way
  door: no behaviour depends on the layout, and the mechanical parts are scriptable.
- **What would make us revisit:** a directory that stops answering one question — most likely
  `transport/`, which at nine source files is the largest and the least homogeneous, and which
  would split into "the IPC front door" and "the byte pumps" if it grows further. A second
  Node-backed store landing in `grants/` is the separate trigger for the footnote above.
