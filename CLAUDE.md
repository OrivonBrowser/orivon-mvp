# Orivon Browser: agent operating instructions

The human documentation is the map; this file holds only what an agent needs on every turn.
**Load the `orivon-workflow` skill at the start of a build step and before opening a PR**: it
holds the tooling table, the review shape, the build-step-end checklist and the `gh` workarounds.
**Load the `orivon-qa` skill before changing the shell UI, a user flow, or anything at a security
boundary, and again before calling such a change done**: it says which QA to run, how to read a
failure and a screenshot, and why a check is never weakened to pass. Compiling is not done.

Status and roadmap: `README.md`. What works today: `docs/planning/compatibility-matrix.md`.

## Read before

| Before | Read |
|---|---|
| Proposing a design | `ARCHITECTURE.md` |
| Writing against the API | `src/contracts/`: the product surface in seven files |
| Editing in a directory | its `README.md`: what it may depend on and must never import |
| Writing code | `docs/development/code-guidelines.md` §Rules, nothing else |
| Adding a test or a `check:*` guard | `docs/development/testing.md` |
| Changing UI, a flow, or broker, IPC, preload, natives, filesystem or network code | the `orivon-qa` skill |
| Starting a build step, or syncing `main` | `docs/development/parallel-work.md` §If you are an agent |
| Opening a PR | `docs/development/pr-blueprint.md` |
| Asking why, or who decided | `docs/decisions/decision-log.md` |
| Hunting for a document | `docs/README.md` |
| Running or porting a third-party app | `../orivon-ports/CLAUDE.md` |

## The load-bearing idea

The durable asset is the capability API (`orivon.*`), written as types in `src/contracts/`. A
shortcut in `src/main/` costs a refactor of code tied to Electron; a shortcut in
`src/contracts/` costs every app ever written for Orivon.

## Session budget

- One PR per session. A new task is a new session; never resume a session across days.
- Compact when the task changes, with a one-line summary of what is done and what is next.
- Explore with an `Explore` agent, not `cat`. Never print a file over 300 lines: use `sed -n`
  ranges or `grep -n`.
- Never read `docs/open-questions.md` whole; grep for the ID.
- Filter test and guard output to its summary lines (`npm test 2>&1 | tail -5`).
- Plans stay under 2,000 words, live in a file, and are cited by path, never pasted back.

## Rules

Other pages cite these by number: a new rule goes at the end, and none is renumbered.

1. **Do not silently promote assumptions into architecture.** A choice that is load-bearing and
   reversible only at cost gets an ADR (`docs/decisions/ADR-0000-template.md`).
2. **Public code and docs say how Orivon works now: never who decided it, never how it got
   there.** Dates, decision IDs and names go in `docs/decisions/`; history stays in git. No
   "used to", no "corrected <date>", no PR numbers, no struck-through rows. A rejected
   alternative may stay as a reason, never as a story. Mark an unconfirmed call *provisional*
   and say what would settle it. Exempt: `CHANGELOG.md`, `docs/decisions/`,
   `docs/open-questions.md`, the readability and review-coverage logs, `devlog/`, and
   `docs/planning/` except `build-plan.md` and `compatibility-matrix.md`.
3. **Surface contradictions, never smooth them over.** File one in `docs/open-questions.md` in
   its fixed shape (12 lines at most); a resolved entry becomes one row in
   `docs/decisions/resolved-questions.md`. A page found wrong is rewritten to be right, never
   given a correction block, and the change earns a decision-log row.
4. **Build a feature when a need calls for it**: a real app, a user, or the success metric (100
   active users in EU/USA, active = 25 h/month). Name the need first; `docs/scope.md` records
   what lands. When scope is why you stop, say so plainly.
5. **Label every component durable or tied to Electron** (`ARCHITECTURE.md` §Where things live).
6. **Prefer mature components.** Build, use a library, fork, embed, or define an interface; do
   not reinvent without a written reason.
7. **Don't over-document trivia**, and don't create abstractions for elegance alone.
8. **No native modules in Orivon's own dependencies**: they break run-from-source on Windows and
   macOS. JavaScript and WebAssembly pass. This bounds this repository's `npm install`, never
   the apps Orivon runs (ADR-0036).
9. **Say which scope a sentence bounds**: this build, this repository, or the project. Never
   state a boundary of this version as permanent, or an aspiration as a plan here. Worked
   examples: `docs/development/readability-log.md` §What these rounds changed.
10. **Remove worktrees once their work is on `main`**: `node scripts/worktree-gc.mjs --remove`.
11. **A rule the owner states twice goes into the repository in the same session**: a hook, a
    guard or a line here, never only memory. Memory is keyed to the checkout path and stops
    loading after a move.
12. If you create a PR, always ensure it has no merge conflicts and passes all tests
13. Ask questions trough the tool, and never stop working until feedback/decision from owner is the only real bottleneck
14. Merge PR's by yourself, unless owner decision is critical. This is preferred for faster development, 

## Commands

| Command | When |
|---|---|
| `npm run typecheck` | After any `.ts` change; it covers `test/` as well as `src/` |
| `npm test` | Unit tests (Vitest) |
| `npm run check:<name>` | The twelve guards in `docs/development/testing.md` §Guards; CI runs each |
| `npm run smoke` | The real shell launches and works. Read its JSON failure list, not the exit code |
| `npm run test:e2e` | The Electron end-to-end suite; a failed spec leaves its evidence in `qa-artifacts/latest/` |
| `npm run qa`, `qa:visual`, `qa:report` | Before calling a UI, flow or boundary change done; `orivon-qa` says which, and how to read the screenshots |
| `npm run dev` | Humans only: it opens a real window |

## Syncing `main`, and PR cadence

- **Never a bare `git pull`.** Clean tree: `git merge --ff-only origin/main` without asking;
  never a merge commit, never `--force`. Dirty tree: report, do not act; name the files dirty
  locally and changed upstream, and stash only when told to.
- **Open one or two PRs per working day, not one per feature.** A second only when the day
  splits into two unrelated themes; `stream/` branches converge into the day's PR. The
  carve-out: a change to `src/contracts/` or `src/shared/` goes alone and merges first. A day
  PR is harder to revert and bisect, so each `## Changes` entry must be findable on its own and
  `## How it was verified` covers the whole day.

## Local quirks

Nothing an agent does may appear on the owner's screen or play on their speakers: no window, no opened tab,
no notification, no sound (`test/launch-electron.mjs` silences every launch).

- Launch Electron only through `smoke`, `test:e2e` or `node scripts/run-headless.mjs <command>`.
- `ELECTRON_RUN_AS_NODE=1` is set in this shell; the `orivon-electron` skill says what it breaks.
- No in-place branch switch or tree-wide discard: work in a worktree.
- A path in angle brackets resolves in the gitignored `.claude/local-paths.md`; a
  machine-absolute path never goes into a tracked file.

## Conventions

- Docs are Markdown, `kebab-case.md`, ASCII prose (`§` is open, A91). Code is TypeScript only.
- Ported third-party apps live in `../orivon-ports`, and nothing here may depend on that
  checkout; the apps this repository's own tests serve live under `test/apps/`.
