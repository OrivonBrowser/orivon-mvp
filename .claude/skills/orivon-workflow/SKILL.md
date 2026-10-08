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

Two practices with no tool behind them:

- **Write the failing test first** for any broker or policy function.
- **On a failure, reproduce it before changing code.**

## Review shape

- **One `/code-review` per PR, before merge.** `/security-review` as well when the PR crosses a
  security boundary.
- **`adversarial-reviewer` at the end of a build step only**, on the broker and the loader at
  minimum.
- **No multi-lane review of a commit range** unless the owner asks for one.
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

## Landing a session, and opening a PR

A session ends by merging its branch into local `main` at the root checkout, only when that tree
is clean (CLAUDE.md, section Syncing `main`). It does not push local `main` and does not open the
day PR: the routine in `.claude/commands/ship-day.md` does, at 13:00 and 21:00. A session opens a
PR itself only for a change to `src/contracts/` or `src/shared/`, alone, from a branch based on
`origin/main`, and for a repair the routine cannot make. The recipes below apply to both.

- `gh pr create --title ... --body-file <file>`. `--body` bypasses the template silently;
  `--label` on create fails with a GraphQL "Projects (classic)" error.
- Edit a body: `gh api -X PATCH repos/OrivonBrowser/orivon-mvp/pulls/<n> -F body=@<file>`
  (`-F` reads the file; `-f` sends the literal string). `gh pr edit` fails the same way as
  `--label`.
- Label: `gh api -X POST repos/OrivonBrowser/orivon-mvp/issues/<n>/labels -f labels[]=<label>`.
- Read CI: `gh pr view <n> --json mergeStateStatus,statusCheckRollup`. This `gh`'s `pr checks` has no
  `--json`, so a script built on it sees no checks and waits for ever. A failed shard's spec:
  `gh api repos/OrivonBrowser/orivon-mvp/actions/jobs/<job id>/logs`, then grep for ` FAIL `.
  An empty `statusCheckRollup` is no run yet, never "all passed": checks appear some seconds after a
  push, and a `DIRTY` PR (a conflict with `main`) starts none until `main` is merged in. A wait loop
  ends only when the list is non-empty and nothing in it is pending.

## Context that rarely changes what you do

- `docs/inventory.md` indexes all prior material; do not re-crawl the filesystem for it.
- `<prior-mvp>` is an earlier prototype that failed: a visual reference for its GUI, never a baseline.
- The vision corpus at `<vision-corpus>` (orivon-docs) is outdated. Verify anything derived from
  it with the owner before treating it as true, and never copy it here.
- ADRs are numbered in sequence and never renumbered once on `main`. Two branches can take the
  same number without a git conflict; the one that merges later renumbers its own.
