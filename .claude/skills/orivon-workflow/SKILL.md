---
name: "orivon-workflow"
description: Use at the start of a build step, before opening or editing a PR, before a review run, at the end of a build step or a notable session, or when deciding which plugin, skill or MCP server to reach for in this repository. Holds the tooling table, the review shape, the build-step-end checklist and the gh workarounds that CLAUDE.md points to.
---

# How work runs in this repository

CLAUDE.md holds the rules every turn needs. This skill holds what a step needs.

## Tooling: what fires when

Plugins are project-scoped (`.claude/settings.json`) and travel with the repository. Some fire automatically; the rest
are invoked at the step named, so check this table at the start of every build step.

| Tool | Fires | Use it for |
|---|---|---|
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main, preload and renderer. Trust its diagnostics over your own reading of a type |
| `security-guidance` | Automatic: edits, stop, every `git commit` and push | Path traversal (T1), local-network reach (T12), secrets. Address or acknowledge every finding |
| hookify rules (`.claude/hookify.*.local.md`) | Automatic on edits and shell commands | Each rule body says what it blocks and what to do instead. **Block:** native modules (in code and in `package.json`), insecure `webPreferences`, non-TypeScript sources, an Electron launch that bypasses `scripts/run-headless.mjs` or could take focus, an X or GNOME server that could take over the owner's display (typed, or written into a script), in-place branch switches (`git pull`/`checkout`/`switch`, `gh pr checkout`), tree-wide discards (`reset --hard`, `clean -f`, `stash drop`), and a whole unit or e2e suite run locally. **Warn:** hardcoded storage paths, features not built yet, file-header essays, comments that narrate the change instead of the code, live pages that narrate their own history (CLAUDE.md Rule 2), and a long CI runner put in the background with a shell `&`, whose end nobody hears of. When the owner corrects the same thing twice, add a rule with `/hookify`. Start its `file_path` pattern with `^(?:.*/)?` before the directory name, because a repo-root anchor never matches the absolute path an edit passes, and the rule dies silently. There is no `not_regex_match` operator, and an unknown operator kills the whole rule (A55) |
| `superpowers` | Process, automatic via its session hook | `brainstorming` before new work, `writing-plans` for anything multi-step, `test-driven-development` for every broker or policy function, `systematic-debugging` on any failure, `verification-before-completion` before claiming done |
| `context7` (MCP) | **Manual, before code against Electron or webtorrent APIs** | `protocol.handle`, `utilityProcess`, `MessagePortMain`, `WebContentsView`, `session` partitions, `safeStorage`; webtorrent 3.x internals. Electron 44 is newer than training data: check a signature live before trusting the remembered one |
| `playwright` (MCP) | **Manual: the localhost fixture app** | Driving a real web page. The Electron e2e uses the `_electron` library, not this |
| `orivon-electron` skill | **Manual, before writing or debugging Electron or webtorrent code** | The renderer-bundling alias recipe, `app.windows()` over `app.firstWindow()`, `MessagePortMain` silent failures, and checking `electron.d.ts` before trusting any claim about `BaseWindow` options. Written nowhere else |
| `orivon-qa` skill | **Manual, after a UI, flow or boundary change, and before calling it done** | Which QA to run, how to read an e2e failure and a screenshot, the fix loop |
| `orivon-comments` skill | **Manual, before writing a comment in `src/`** | Where rationale goes when it is not a "you will break this line" comment, and how to handle a header over budget |
| `orivon-porting` skill | **Manual, before porting, updating, republishing or fixing an app, or a change here that a port asked for** | Loads the porting skill kept in `../orivon-ports`, and says what this repository owes a port: a generic fix, a catalogue row and a spec |
| `claude-security` | **Manual, before packaging (step 10)** | Whole-repository multi-agent vulnerability scan with verified findings. Expensive: milestones only |
| `claude-md-management` | **Manual, `/revise-claude-md`** at the end of a session that changed an assumption in CLAUDE.md | Keeps CLAUDE.md true |
| `adversarial-reviewer` (user skill) | **Manual, after each build step lands** | A multi-perspective hostile review; `docs/planning/audit-2026-08-25.md` is what one produces. Run it on the broker and the app loader at minimum |
| `/code-review`, `/security-review`, `/simplify` | Manual | Per-diff review before each commit on the critical path; how often a PR gets one is section Review shape |
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

Append one bullet to `devlog/journal.md` as `CLAUDE.md` section Devlog capture says; skip routine sessions.

## Opening and editing a PR

- `gh pr create --title ... --body-file <file>`. `--body` bypasses the template silently;
  `--label` on create fails with a GraphQL "Projects (classic)" error.
- Name the body file after the branch (`pr-body-<branch>.md`). The agents of one session share a scratchpad, so a
  common name like `pr-body.md` lets one agent's body be PATCHed onto another agent's PR.
- Edit a body: `gh api -X PATCH repos/OrivonBrowser/orivon-mvp/pulls/<n> -F body=@<file>`
  (`-F` reads the file; `-f` sends the literal string). `gh pr edit` fails the same way as
  `--label`.
- Label: `gh api -X POST repos/OrivonBrowser/orivon-mvp/issues/<n>/labels -f labels[]=<label>`. A `ci:` label starts a
  run that cancels the one running, whenever it is added, and the cancelled run stays on the PR with a red `e2e` beside
  the real one. It does not block a merge and `pr-watch.mjs` reads past it, so leave it: rerunning it repeats the suite.
- Read CI: `gh pr view <n> --json mergeStateStatus,statusCheckRollup`. This `gh`'s `pr checks` has no
  `--json`, so a script built on it sees no checks and waits for ever. A failed shard's spec:
  `gh api repos/OrivonBrowser/orivon-mvp/actions/jobs/<job id>/logs`, then grep for ` FAIL `.
  An empty `statusCheckRollup` is no run yet, never "all passed": checks appear some seconds after a
  push, and a `DIRTY` PR (a conflict with `main`) starts none until `main` is merged in. A wait loop
  ends only when the list is non-empty and nothing in it is pending.
- Wait and merge: `node scripts/ai/pr-watch.mjs <n> --update <worktree> --stop '<your area's spec path>'`, in the
  background with a two-hour limit (`timeout: 7200000`: the default 30 minutes ends it while `main` keeps moving), never
  behind a shell `&`; never hand-write the loop. A run a later run on the same commit replaced is not a failure, whatever its jobs ended as. It reruns failed e2e shards and unacquired runners at most twice, except a
  spec matching `--stop`, and prints the failed specs, which the PR then names as flakes (CLAUDE.md Rule 11). Green but
  BEHIND, it merges `main` into the worktree's branch and pushes (six rounds at most); it merges when every check
  passed and the branch is CLEAN, and stops on any other failure, on a conflict and on a moved head. It merges with a
  merge commit, so every commit of the branch lands on `main`: when one must not (it carried something later removed),
  pass `--squash`. A subagent always gets `--no-merge`, so that the session that briefed it merges. Read its exit
  from the PR's state, never from a pipe's: `cmd | tail` exits 0 whatever `cmd` did.
- A conflict in `docs/decisions/decision-log.md` after merging `main` in (two branches took the same d-number):
  `node scripts/ai/renumber-decisions.mjs` keeps main's rows, renumbers the branch's after them, rewrites the
  branch's own references to those ids, and prints the mapping. Then commit the merge. pr-watch's `--update`
  does this by itself when the log is the only conflict.
- `npm run test:changed` follows imports. A test that reads source files from disk (an import graph, a bundle, a
  walk over a folder) says so with `// test:changed reads <folders or files>` (`docs/development/testing.md`), or
  nothing local selects it.

## Context that rarely changes what you do

- `docs/inventory.md` indexes all prior material; do not re-crawl the filesystem for it.
- `<prior-mvp>` is an earlier prototype that failed: a visual reference for its GUI, never a baseline.
- The vision corpus at `<vision-corpus>` (the earlier vision docs, not public) is outdated. Verify anything derived from
  it with the owner before treating it as true, and never copy it here.
- ADRs are numbered in sequence and never renumbered once on `main`. Two branches can take the
  same number without a git conflict; the one that merges later renumbers its own.
