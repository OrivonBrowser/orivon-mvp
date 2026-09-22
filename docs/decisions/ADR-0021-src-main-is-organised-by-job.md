# ADR-0021: `src/main/` is organised into nine job-named directories

- **Status:** accepted
- **Date:** 2026-09-22
- **Type:** architecture
- **Decided by:** owner

## Decision

`src/main/` is organised into nine directories named for the **job** each does, on the same
naming convention ADR-0015 established for `src/broker/`: `shell/` (compose the window and its
views), `browsing/` (what the address bar and tab strip are made of), `ipc/` (the chrome→main
channels), `consent/` (decide what to ask, say it, show it), `permissions/` (the revocable grant
list), `install/` (a hinted manifest becomes a registered, consented app), `sessions/` (what an
Electron `Session` is allowed to do), `self-update/` (check, notify, never install), `dev/`
(inert or compiled out of an ordinary build).

`index.ts`, `registry.ts`, `subsystems.ts` and `channels.ts` stay at the top level because they
belong to no single job, and `registry.ts`/`channels.ts` are the seam other packages
(`src/broker/transport/ipc.ts`, `src/loader/subsystem.ts`, every `src/preload/` file) import as
**values** — the same reason `src/broker/`'s `index.ts`, `broker-contracts.ts` and `errors.ts`
stayed put.

Within a directory, the filename suffix carries a second axis ADR-0015's decomposition did not
need: `<name>.ts` is the decision (no `electron` import, unit-tested under plain vitest),
`<name>-prompt.ts` is the native dialog that shows it, `<name>-subsystem.ts` registers it into
the running app, `<name>-runner.ts` is the real I/O around it. This vocabulary already existed
across six files before this change gave it a name; grouping by job rather than by this axis is
deliberate — see Alternatives.

Every directory carries a `README.md` on the same template `src/broker/`'s subdirectories use:
what lives here, what it depends on, what it must never import, owner stream, then `## Design
notes` for the rationale specific to its own files. Tests move into a `tests/` folder inside the
directory whose code they cover, per `code-guidelines.md`'s existing repo-wide rule.

## Context

`src/main/` held 42 source files and 37 test files in two flat directories, alphabetised, so
`app-install.ts` sat between `index.ts`-adjacent boot code and `bookmarks.ts` with nothing
signalling that one is the loader-to-broker glue, one is the process entry, and one is a JSON
store. This is the same problem `src/broker/` had at 83 files, solved the same way in ADR-0015;
`src/main/` grew past that same pressure point without anyone deciding to reorganise it, the
same "nobody decided, it just drifted" pattern the comment-budget guard exists to catch for a
different failure.

The pressure had gone into `src/main/README.md` instead: 622 lines, roughly 560 of them
`## Design notes` carrying rationale for files a reader had no structural way to find, opening
with a hand-maintained per-file table — the exact alternative ADR-0015 already considered and
rejected for the broker ("a map maintained by hand next to the thing it maps is the same bet,
made again").

This ADR exists because CLAUDE.md Rule 1 asks that a load-bearing choice reversible only at cost
be written down. The layout qualifies on both counts, the same way ADR-0015 did: it asserts a
decomposition of the process, and reversing it means another whole-directory move with every
path reference rewritten again.

## Alternatives considered

**Keep the flat layout, add back a file-map table.** Rejected for the identical reason ADR-0015
gives: it does not reduce what a reader scrolls past, and this repository has direct evidence
such a document drifts (the comment budget is enforced in CI precisely because "the rule was
being followed and the codebase drifted anyway").

**Five coarse directories, matching the broker's own directory count.** Considered, since parity
with `src/broker/` has some appeal. Rejected: `src/main/`'s 42 files do not decompose into five
jobs of even size the way the broker's decide/remember/hold/do/speak pipeline did — the nearest
five-way grouping left two buckets at thirteen files each, which is closer to the flatness being
fixed than to a real decomposition. ADR-0015's own amendment already says its five-directory
shape is broker-specific and not a template for other directories; this ADR does not borrow the
count, only the naming convention and the README template.

**Split by whether a file imports `electron`, `core/` versus `electron/`.** The option that
sounds most aligned with the suffix vocabulary this ADR does adopt, and rejected for the same
reason ADR-0015 rejected its own `core/`-versus-`plumbing/` split: the dividing line would put
`install-consent.ts` and `install-consent-prompt.ts` — one feature, read together by anyone
auditing consent — on opposite sides of a directory boundary, which hides the pairing rather
than showing it. The suffix already carries this information at the filename level; a second,
directory-level encoding of the identical fact adds a boundary to cross for no reader benefit.

**A single `dialogs/` directory for every `*-prompt.ts` file, one level more than what
shipped.** Genuinely considered: it would let `consent/` (and every other directory) claim "no
`electron` import" as an enforceable boundary, the same shape `src/broker/policy/` already gets
to claim. Not taken, for the reason directly above: `install-consent.ts` and
`install-consent-prompt.ts` read as one feature, and separating the dialog from the decision it
shows would recreate exactly the audit-hiding failure the `core/`/`plumbing/` alternative was
rejected for, just one layer down. `consent/`'s own README states the resulting boundary
honestly instead: `electron` is absent from every file except the three named `*-prompt.ts`
files, not from the whole directory.

## Reasoning

The decomposition is not invented for the filesystem, the same claim ADR-0015 makes and for the
same reason: every file already did exactly one job, and the flat directory simply refused to
say which. `sessions/` is the one directory this reorganisation actually discovered rather than
merely named: `permission-gate.ts` and `web-context-host.ts` were never filed together, and both
do the identical job of constraining what an Electron `Session` may do — grouping them makes
that shared job visible for the first time.

Grouping by job, with the suffix carrying the pure/Electron axis inside each directory, is a
better fit for `src/main/` than the broker's job-only decomposition was for `src/broker/`,
because `src/main/`'s features are naturally vertical: a consent decision, its wording, and its
dialog are one thing a reader wants to see together, not three things scattered across a
decide/say/show set of top-level directories. `consent/`'s own README states the resulting
boundary as a fact about the directory (`electron` absent from every file except the three named
`*-prompt.ts` ones) rather than as an enforced rule, matching ADR-0015's own "the boundaries are
prose, enforced by nothing" admission — the gap has the same name here it has there, `A85`.

## Consequences

**Committed to:** nine directories whose names are a claim about what the code does, and nine
README files that must stay true, plus a suffix vocabulary now written down once rather than
re-derived per file. A file whose job changes has to move, and a boundary that stops holding has
to be corrected in the README rather than quietly violated.

**The unpleasant part, stated plainly, same as ADR-0015's:** the boundaries are prose. Nothing
mechanically stops `browsing/favicon.ts` from importing `../shell/tabs.ts` tomorrow, the one
local rule `browsing/README.md` states. That gap is `A85`, already open for the broker's own
directories and now covering `src/main/`'s too.

**Cross-repository cost, paid once.** Rewriting paths in a repository whose comments and docs
are its documentation touched 313 import specifiers across 104 `.ts` files and 94 prose
references across 20 Markdown files. That is the recurring tax on any future move of this kind.

## Reversibility

- **Cost to reverse:** expensive. Another whole-directory move, with every import specifier,
  comment reference and documentation link rewritten again. Not a one-way door: no behaviour
  depends on the layout, and the mechanical parts are scriptable, the same as ADR-0015's own
  assessment.
- **What would make us revisit:** a directory that stops answering one question, most likely
  `consent/` at twelve files, the largest here the same way `transport/` was the broker's
  largest — if it grows further it would split into "the three decisions" and "everything about
  rendering and showing them."
