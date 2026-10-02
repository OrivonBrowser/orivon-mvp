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
| Running or porting a third-party app. Use to get also instructions when user ask to port an APp | `../orivon-ports/CLAUDE.md` |

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
12. **If you create a PR, always ensure it has no merge conflicts and passes all tests**
13. **Ask questions trough the tool** and never stop working until feedback/decision from owner is the only real bottleneck, owner may be sleeping, and his response should not be the reason for you to stop unless there is no other way around.
14. **Merge session changes in a PR's by yourself**, unless owner decision is critical. Applies for orivon-ports operations as well. This is preferred for faster development. Most of the times if you wait for my approval to merge a PR to main you will end un in a conflict loop, since development goes so fast. If you don't merge it state it very clearly at the end of the prompt.

## Commands

| Command | When |
|---|---|
| `npm run typecheck` | After any `.ts` change; it covers `test/` as well as `src/` |
| `npm test` | Unit tests (Vitest) |
| `npm run check:<name>` | The thirteen guards in `docs/development/testing.md` §Guards; CI runs each |
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

## Tooling: what fires when (`.claude/settings.json`)

Plugins are project-scoped and travel with the repo. Some are automatic; the rest must be invoked
at the step named here. **Check this table at the start of every build step.**

| Tool | Fires | Use it for |
|---|---|---|
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main, preload and renderer. Trust its diagnostics over your own reading of a type |
| `security-guidance` | Automatic: on edits, when you stop, and on every `git commit` | Path traversal (T1), local-network reach (T12), secrets. Address or explicitly acknowledge every finding |
| `hookify` rules in `.claude/hookify.*.local.md` | Automatic on edits and shell commands | Thirteen rules. **Block (8):** native modules (in code and in `package.json`), insecure `webPreferences`, non-TypeScript sources, an Electron launch that bypasses `scripts/run-headless.mjs` or could take focus, in-place branch switches (`git pull`/`checkout`/`switch`, `gh pr checkout`) and tree-wide discards (`reset --hard`, `clean -f`, `stash drop`). **Warn (5):** hardcoded storage paths, vision features not built yet, file-header essays, comments that narrate the change instead of the code, and live pages that narrate their own history (Rule 2). When the owner corrects the same thing twice, add a rule with `/hookify`. Start its `file_path` pattern with `^(?:.*/)?` before the directory name, because a repo-root anchor never matches the absolute path an edit passes, and the rule dies silently. There is no `not_regex_match` operator, and an unknown operator kills the whole rule (A55) |
| `superpowers` | Process, automatic via its session hook | `brainstorming` before new work, `writing-plans` for anything multi-step, `test-driven-development` for every broker or policy function, `systematic-debugging` on any failure, `verification-before-completion` before claiming done |
| `context7` (MCP) | **Manual: before writing code against Electron or webtorrent APIs** | `protocol.handle`, `utilityProcess`, `MessagePortMain`, `WebContentsView`, `session` partitions, `safeStorage`; webtorrent 3.x internals. Training data is stale for this stack (Electron 44), so check a signature live before trusting the remembered one |
| `playwright` (MCP) | **Manual: the localhost fixture app** | Driving a real web page. The Electron e2e uses the `_electron` library, not this |
| `claude-security` | **Manual: before packaging (step 10)** | Whole-repo multi-agent vulnerability scan with verified findings. Expensive: run it at milestones, not continuously |
| `claude-md-management` | **Manual: `/revise-claude-md` at the end of any session that changed an assumption in this file** | Keeps this file true as the code moves |
| `orivon-electron` (project skill) | **Manual: before writing or debugging any Electron or webtorrent code** | The renderer-bundling alias recipe, the `app.windows()`-not-`app.firstWindow()` rule, `MessagePortMain`'s silent failures, and why to check `electron.d.ts` before trusting any claim about `BaseWindow` options. Exists nowhere else |
| `orivon-comments` (project skill) | **Manual: before writing or editing a comment in `src/`** | Where rationale goes when it is not a "you will break this line" comment, and how to handle a header over budget |
| `adversarial-reviewer` (user skill) | **Manual: after each build step lands** | A multi-perspective hostile review; `docs/planning/audit-2026-08-25.md` is what one produces. Run it on the broker and the app loader at minimum |
| `/code-review`, `/security-review`, `/simplify` | Manual | Per-diff review before each commit on the critical path |

## Devlog capture

`devlog/journal.md` feeds the Sunday team devlog (compiled by `/devlog`). At the end of any
session where something notable happened (a milestone, a decision taken or reversed, a direction
change, a worry the owner kept returning to), append a one-line bullet to the current week's
section: **Done / results** for outcomes, **In my head** for thinking. Skip routine sessions.
**25 words at most per bullet**; a result too big for that is two bullets
(`.claude/commands/devlog.md` rule C).