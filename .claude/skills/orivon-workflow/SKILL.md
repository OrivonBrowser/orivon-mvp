---
name: "orivon-workflow"
description: Use at the start of a build step, before opening or editing a PR, before a review run, at the end of a build step or a notable session, or when deciding which plugin, skill or MCP server to reach for in this repository. Holds the tooling table, the review shape, the build-step-end checklist and the gh workarounds that CLAUDE.md points to.
---

# How work runs in this repository

CLAUDE.md holds the rules every turn needs. This skill holds what a step needs.

## Tooling: what fires when

Plugins are project-scoped (`.claude/settings.json`) and travel with the repository.

| Tool | Fires | Use it for |
|---|---|---|
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main, preload and renderer. Trust it over your own reading of a type |
| `security-guidance` | Automatic: edits, stop, every `git commit` and push | Path traversal (T1), local-network reach (T12), secrets. Address or acknowledge every finding |
| hookify rules (`.claude/hookify.*.local.md`) | Automatic on edits and shell commands | Each rule body says what it blocks and what to do instead. New rule: `/hookify`; start a `file_path` pattern with `^(?:.*/)?`, and use only known operators (an unknown one kills the rule silently) |
| `context7` (MCP) | **Manual, before code against Electron or webtorrent APIs** | `protocol.handle`, `utilityProcess`, `MessagePortMain`, `WebContentsView`, `session`, `safeStorage`. Electron 44 is newer than training data: check a signature live |
| `playwright` (MCP) | **Manual: the localhost fixture app** | Driving a real web page. The Electron e2e uses the `_electron` library, not this |
| `orivon-electron` skill | **Manual, before writing or debugging Electron code** | Renderer bundling, `app.windows()` over `app.firstWindow()`, `MessagePortMain` silent failures |
| `orivon-qa` skill | **Manual, after a UI, flow or boundary change, and before calling it done** | Which QA to run, how to read an e2e failure and a screenshot, the fix loop |
| `orivon-comments` skill | **Manual, before writing a comment in `src/`** | Where rationale goes, and a header over budget |
| `claude-security` | **Manual, before packaging (step 10)** | Whole-repository vulnerability scan. Expensive: milestones only |
| `claude-md-management` | **Manual, `/revise-claude-md`** at the end of a session that changed an assumption in CLAUDE.md | Keeps CLAUDE.md true |
| `reader` agent (`.claude/agents/reader.md`) | **Manual: a search of three or more steps** | Finding and quoting code on Haiku: it returns file:line and the quoted lines. Reviews, audits and debugging stay on Sonnet or Opus |

Two practices with no tool behind them:

- **Write the failing test first** for any broker or policy function.
- **On a failure, reproduce it before changing code.**

## Keeping token cost down

Cost follows context size times turn count: every turn re-reads the whole context, and Opus and
Sonnet charge the same for that re-read. So:

- **Batch.** Independent reads, greps and `git` queries go in one turn; ten single reads at a
  300k context cost ten re-reads of it.
- **Brief small.** An implementer gets one PR's worth of work. A long brief grows its context past
  the compaction point, and the compacted agent loses the detail it was working from.
- **Wait without polling.** The main thread runs a long command with `run_in_background` and acts on
  the notification. A subagent waits in one blocking call (`heavy` already queues; `pr-watch.mjs`
  for CI), never in a loop of short checks, each of which re-reads the whole context.

## Review shape

- **One `/code-review` per PR, before merge.** `/security-review` as well when the PR crosses a
  security boundary.
- **`adversarial-reviewer` at the end of a build step only**, on the broker and the loader at
  minimum.
- **No multi-lane review of a commit range** unless the owner asks for one.
- **In a worktree, `/security-review` sees the primary checkout's diff, never the worktree's**, so run by a subagent it has
  reviewed an empty diff without saying so. Review the branch instead: a read-only reviewer agent given
  `git -C <worktree> diff origin/main...` to read, or the `adversarial-reviewer` skill pointed at that diff. Name the diff
  in the prompt and check the report quotes a line from it.
- Each run is one row in `docs/development/review-coverage.md`.

## At the end of a build step

1. The QA the `orivon-qa` skill names for what the step touched (`npm run qa`), with the screenshots read.
2. The adversarial review above.
3. **The readability check.** Give the owner the one document a newcomer would hit at that
   point and ask only: *"Read this cold. Where is the first place you got lost, or had to
   guess?"* Record the answer in `docs/development/readability-log.md` (method in its
   section The protocol). "Nothing confused me" is a result, and it is logged.
4. `docs/features.md` records what landed, and `docs/roadmap.md` moves the item out of Expected next.

## At the end of a notable session

A milestone, a decision taken or reversed, a direction change, a worry the owner kept returning
to: append one bullet to the current week of `devlog/journal.md`, **Done / results** for
outcomes, **In my head** for thinking. At most 25 words; `npm run check:devlog` checks it.
Skip routine sessions.

## Opening and editing a PR

- `gh pr create --title ... --body-file <file>`. `--body` bypasses the template silently;
  `--label` on create fails with a GraphQL "Projects (classic)" error.
- Edit a body: `gh api -X PATCH repos/OrivonBrowser/orivon-mvp/pulls/<n> -F body=@<file>`
  (`-F` reads the file; `-f` sends the literal string). `gh pr edit` fails the same way as
  `--label`.
- Label: `gh api -X POST repos/OrivonBrowser/orivon-mvp/issues/<n>/labels -f labels[]=<label>`, once the PR's checks have
  appeared. A label added in the same second as the PR starts a run that can cancel the opening run (or be cancelled by
  it), which leaves a red `e2e` behind a green suite; `gh run rerun <the cancelled run>` clears it.
- Read CI: `gh pr view <n> --json mergeStateStatus,statusCheckRollup`. This `gh`'s `pr checks` has no
  `--json`, so a script built on it sees no checks and waits for ever. A failed shard's spec:
  `gh api repos/OrivonBrowser/orivon-mvp/actions/jobs/<job id>/logs`, then grep for ` FAIL `.
  An empty `statusCheckRollup` is no run yet, never "all passed": checks appear some seconds after a
  push, and a `DIRTY` PR (a conflict with `main`) starts none until `main` is merged in. A wait loop
  ends only when the list is non-empty and nothing in it is pending.
- Wait and merge: `node scripts/ai/pr-watch.mjs <n> --update <worktree> --stop '<your area's spec path>'`, in the
  background with a two-hour limit (`timeout: 7200000`: the default 30 minutes ends it while `main` keeps moving), never
  behind a shell `&`; never hand-write the loop. A check that a later run of itself cancelled is not a failure. It reruns failed e2e shards and unacquired runners at most twice, except a
  spec matching `--stop`, and prints the failed specs, which the PR then names as flakes (Rule 12). Green but
  BEHIND, it merges `main` into the worktree's branch and pushes (six rounds at most); it merges when every check
  passed and the branch is CLEAN, and stops on any other failure, on a conflict and on a moved head. It merges with a
  merge commit, so every commit of the branch lands on `main`: when one must not (it carried something later removed),
  pass `--squash`. A subagent always gets `--no-merge`, so that the session that briefed it merges. Read its exit
  from the PR's state, never from a pipe's: `cmd | tail` exits 0 whatever `cmd` did.
- A conflict in `docs/decisions/decision-log.md` after merging `main` in (two branches took the same d-number):
  `node scripts/ai/renumber-decisions.mjs` keeps main's rows, renumbers the branch's after them, rewrites the
  branch's own references to those ids, and prints the mapping. Then commit the merge. pr-watch's `--update`
  does this by itself when the log is the only conflict.
- `npm run test:changed` follows imports. A test that bundles a source tree from disk and compares it with a
  committed artifact is listed in `BUNDLED_FROM` (`scripts/test-changed.mjs`), or nothing local selects it.

## Context that rarely changes what you do

- `docs/inventory.md` indexes all prior material; do not re-crawl the filesystem for it.
- `<prior-mvp>` is an earlier prototype that failed: a visual reference for its GUI, never a baseline.
- The vision corpus at `<vision-corpus>` (the earlier vision docs, not public) is outdated. Verify anything derived from
  it with the owner before treating it as true, and never copy it here.
- ADRs are numbered in sequence and never renumbered once on `main`. Two branches can take the
  same number without a git conflict; the one that merges later renumbers its own.
