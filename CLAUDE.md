# Orivon MVP: agent operating instructions

**The human documentation is the map. This file adds only what is specific to working here as
an agent.** It is loaded into every session, so a line that does not change what an agent does
does not belong in it.

| Read | Before |
|---|---|
| `README.md` | anything: what Orivon is, its status, its roadmap |
| `ARCHITECTURE.md` | proposing a design: how the pieces fit, and which are disposable |
| `docs/README.md` | hunting for a document: it is the index and the sources-of-truth table |
| `src/contracts/` | writing against the API: the product surface in seven files, faster than any prose |
| The `README.md` of the directory you are in | editing there: what it may depend on and what it must never import |
| `docs/development/parallel-work.md` | starting a build step, or syncing `main` |
| `docs/development/code-guidelines.md` | writing code |
| `docs/development/testing.md` | adding a test or a `check:*` guard |
| `docs/development/pr-blueprint.md` | opening a PR |
| `docs/decisions/decision-log.md` | asking *why* or *who decided*: pages do not carry that |
| `../orivon-ports/CLAUDE.md` | running, updating or porting a third-party app. That repository has rules of its own |

**Every page states only what is true now**, except the change records Rule 2 lists. No page
tells you that it changed or who decided it: that is git, the decision log and the ADRs. **ADRs
are the exception.** An ADR is itself a decision record, so it carries its amendments in place,
and where one contradicts itself the amendment is the current text.

## Status (2026-09-25)

Build steps 1-4 of 10 are done: shell, capability broker, Node shim, app loader (DDOC included). A
person can open an app's URL, grant what its manifest declares in one consent dialog, and revoke
grants later from a permissions panel. The permission engine is roughly 90% done, and the work now
is building real apps on it: build step 5 ports Node.js desktop apps in `../orivon-ports` as the
platform's test cases. Build step 6, ENS and IPFS, is done: a `.eth` name loads from IPFS, its
name proven by a light client and every byte verified on this machine. The torrent app and Nostr
identity are ideas, not build steps (`docs/mvp-scope.md` §LATER).

**For what works today, read `docs/planning/compatibility-matrix.md`, not this section.**

## What this repository is

The MVP implementation of **Orivon**, not its vision documentation.

It proves one thing: that a browser can run applications **impossible in Chrome**, reaching the
network and filesystem under user-granted, per-app capabilities, while those applications remain
ordinary web frontends delivered from a URL.

Success metric: **100 active users in EU/USA, active = 25 h/month.** The metric decides this
build's scope. It does not bound the long-term vision.

- **A path in angle brackets resolves in `.claude/local-paths.md`.** That file is gitignored and
  exists only on the owner's machine. A machine-absolute path never goes into a tracked file: add
  it there, and write the placeholder instead.
- **The vision corpus lives at `<vision-corpus>`** (canonical; public as
  [orivon-docs](https://github.com/OrivonBrowser/orivon-docs), deployed at docs.orivonstack.com).
  Summarise and link. **Never copy it into this repository**, which is deliberately narrower.
- **`docs/inventory.md` indexes all prior material.** Do not re-crawl the filesystem for it.
- **`<prior-mvp>` is a failed prior MVP.** Not a baseline and not a reference architecture; its
  GUI is a *visual* reference only.
- **Ported third-party apps live in `../orivon-ports`**, with the harness that clones, builds and
  serves them, and the porting guide. A port consumes `orivon.*` and is never part of it, so
  nothing here may depend on that checkout being present. The apps this repository serves to its
  own tests live under `test/apps/`. There is no top-level `apps/` directory.

## The load-bearing idea

The durable asset is the **capability API** (`orivon.*`), written as types in `src/contracts/`.
The Electron shell beneath it is knowingly disposable, and the interface is designed so the
implementation underneath could change without any app already written having to change.

**Practical consequence: a shortcut in `src/main/` costs a refactor of code that was replaceable
anyway. A shortcut in `src/contracts/` costs every app ever written for Orivon.**

## Rules

Other pages cite these by number, so a new rule goes at the end and none is ever renumbered.

1. **Do not silently promote assumptions into architecture.** If a choice is load-bearing and
   reversible only at cost, write an ADR (`docs/decisions/ADR-0000-template.md`).
2. **Public code and docs say how Orivon works now: never who decided it, never how it got there.**
   Dates, decision IDs and names go in `docs/decisions/decision-log.md` or an ADR; change history
   stays in git. So: no "what changed since", no "used to", no "corrected <date>", no PR numbers,
   no lane or run narration, no struck-through rows. A rejected alternative may stay as a reason
   ("gating on X would race"), never as a story. Mark an unconfirmed call *provisional*, and say
   what would settle it. **Exempt, since their subject is change:** `CHANGELOG.md`,
   `docs/decisions/`, `open-questions.md`, the readability and review-coverage logs, `devlog/`,
   and `docs/planning/` apart from `build-plan.md` and `compatibility-matrix.md`.
3. **Surface contradictions, never smooth them over.** Append to `docs/open-questions.md`. When a
   page turns out to be wrong, **rewrite it to be right** rather than appending a correction
   block beneath the wrong text. The page states what is true now, and the change earns a row in
   the decision log.
4. **Scope discipline. Anything absent from `mvp-scope.md`'s IN table is out by default.** The
   vision corpus is large, coherent and seductive, and the developer is solo: scope creep out of
   it is the single biggest risk this project has. When scope is the reason you stop a piece of
   work, say so plainly.
5. **Label every component disposable or durable**: say whether it is tied to Electron or would
   outlive it. `ARCHITECTURE.md` §Where things live has the table. This is about spending care in
   the right place, not about a planned migration.
6. **Prefer mature components.** For each subsystem, decide: build, use a library, fork, embed,
   or define an interface. Do not reinvent without a written reason.
7. **Don't over-document trivia**, and don't create abstractions for elegance alone.
8. **Pure-JS dependencies only.** Native modules break run-from-source, which is how Windows
   and macOS are supported (`docs/planning/build-plan.md` §Platform policy).
9. **Say which scope a sentence bounds**: this build, this repository, or the project. Never
   state an MVP boundary as a permanent property of Orivon, and never state a long-term
   aspiration as a plan for this repository. A reader cannot recover which you meant from
   context, and will believe whichever the sentence implies. Two worked examples, both real
   mistakes made here: `docs/development/readability-log.md` §What these rounds changed about how
   the docs are written.

## Commands

| Command | When |
|---|---|
| `npm run typecheck` | After any `.ts` change. Strict, and it covers `test/` as well as `src/` |
| `npm test` | Unit tests (Vitest) |
| `npm run check:<name>` | Any of the eleven guards below. CI runs every one |
| `npm run smoke` | Proving the real shell still launches and works. Read its JSON failure list, not only the exit code |
| `npm run test:e2e` | The Electron end-to-end suite |
| `npm run dev` | **Humans only.** It opens a real window, so hookify blocks it for an agent |

`smoke` and `test:e2e` build first and already run headless. Any other Electron launch goes
through `node scripts/run-headless.mjs <command>`; §Local quirks says why.

The eleven guards. `docs/development/testing.md` §Guards is the canonical list, and a new
`check:*` script with no CI step fails the unit suite.

- `contracts`: `src/contracts/` is complete and imports only its own siblings. `./errors.js` is
  fine; `electron`, `node:*` or any package is not.
- `natives`: Rule 8. Also runs on `postinstall`.
- `size`, `comments`: code-guidelines Rules 2 and 1.
- `questions`: no duplicate A-number in `open-questions.md`.
- `page-globals`: ADR-0021. A global Orivon installs on an app's window must be replaceable by
  the app.
- `manifest-parity`: the loader accepts every field the manifest contract declares.
- `vectors` (golden vectors), `secrets`, `advisories` (no high or critical advisory), and
  `dev-grant-absent` (the developer-only grant path is absent from a packaged build).

## Working here

Four owner policies. Nothing below is a suggestion.

### Parallel work, and syncing `main`

Read `docs/development/parallel-work.md` before starting a build step. Its "If you are an agent"
section is the checklist; worktree setup, stacked PRs and branch protection are in the page.

**Syncing `main` with `origin`: never a bare `git pull`.** It refuses on a dirty tree, and the
usual recoveries (`git checkout -- .`, a botched rebase) destroy uncommitted work silently. The
procedure is in that page's §Syncing `main` with `origin`.

- **Clean tree: sync without asking** (`git merge --ff-only origin/main`; never a merge commit,
  never `--force`).
- **Dirty tree: report, do not act.** Name the files that are dirty locally **and** changed
  upstream. Back up and stash only if told to go ahead.

### Before writing code: the code guidelines

Read `docs/development/code-guidelines.md`. Three rules: **comments earn their place**, **no
source file over 500 lines** (800 for tests), **one implementation per idea**. That page says
outright that its §Rules 1-3 is all you need in order to write code here and everything below it
is background. Its §Status is the current enforcement state. Read those two and nothing else.

### Before opening a PR: the PR blueprint

**Open one or two PRs per working day, not one per feature.** This is an **agent rule and lives
here on purpose**: a human contributor sending one change still opens one PR, so
`CONTRIBUTING.md` and the PR template say nothing about cadence.

- Default to one PR for the day. Open a second when the day splits into two unrelated themes, or
  when one body would be too tangled to follow.
- `stream/` branches and worktrees are unchanged: they converge into the day's PR instead of each
  opening their own.
- **`src/contracts/` and `src/shared/` are the one carve-out**, still alone and merged first. A
  day that touches contracts has an extra PR; that is expected, not a slip.
- **State what the size costs.** A day PR is harder to revert and harder to bisect. `## Changes`
  must make each piece separately findable, and `## How it was verified` must cover the whole
  day, not the last thing touched. A day PR whose body is one paragraph is worse than the
  twenty-five it replaced.

Read `docs/development/pr-blueprint.md` for the shape itself: the title rule, the five required body sections,
labels, and the anti-patterns an agent actually hits. Its §Where the three copies live settles
precedence: that document is canonical and `.github/pull_request_template.md` derives from it.

Worth knowing before you get there, because it is what stops you reading the rest: **a PR opened
with `gh pr create --body` bypasses the template entirely, and nothing will say so.** Use
`--body-file`, and see §Local quirks for the `gh pr edit` and labelling workarounds.

### At the end of a build step: the readability check

Give the owner one document, the one a newcomer would hit at that point, and ask only this:

> *Read this cold. Where is the first place you got lost, or had to guess?*

Record the answer in `docs/development/readability-log.md`, which has the full method in its
§The protocol. This happens at **every** build step, and "nothing confused me" is a real result
that still gets logged.

## Local quirks

- **Nothing an agent does may appear on the owner's screen.** The owner works on this machine
  while agents run: no Electron window, no opened editor tabs or `xdg-open` URIs, no desktop
  notifications. Every Electron launch goes through `node scripts/run-headless.mjs <command>`.
  `xvfb-run` alone is not enough on this Wayland desktop: Electron finds the real compositor and
  opens there. Two hookify rules block any other launch.
- **`ELECTRON_RUN_AS_NODE=1` is set in this machine's ambient shell.** It turns the Electron
  binary into windowless plain Node with no error, so tests hang or pass against nothing.
  `test/launch-electron.mjs` strips it and checks that the launch is real;
  `.claude/skills/orivon-electron/` has the rest.
- **`gh pr edit` fails with a GraphQL "Projects (classic)" error**, as does `--label` on
  `gh pr create`; this is unrelated to auth or content. Creating a PR is fine: plain
  `gh pr create --title ... --body-file ...` with no `--label` works. To edit an existing body,
  use `gh api -X PATCH repos/OrivonBrowser/orivon-mvp/pulls/<n> -F body=@file` (`-F` reads the
  file; `-f` would send the literal string `@file`). To label one, use
  `gh api -X POST repos/OrivonBrowser/orivon-mvp/issues/<n>/labels -f labels[]=<label>`.

## Tooling: what fires when (`.claude/settings.json`)

Plugins are project-scoped and travel with the repo. Some are automatic; the rest must be invoked
at the step named here. **Check this table at the start of every build step.**

| Tool | Fires | Use it for |
|---|---|---|
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main, preload and renderer. Trust its diagnostics over your own reading of a type |
| `security-guidance` | Automatic: on edits, when you stop, and on every `git commit` | Path traversal (T1), local-network reach (T12), secrets. Address or explicitly acknowledge every finding |
| `hookify` rules in `.claude/hookify.*.local.md` | Automatic on edits and shell commands | Thirteen rules. **Block (8):** native modules (in code and in `package.json`), insecure `webPreferences`, non-TypeScript sources, an Electron launch that bypasses `scripts/run-headless.mjs` or could take focus, in-place branch switches (`git pull`/`checkout`/`switch`, `gh pr checkout`) and tree-wide discards (`reset --hard`, `clean -f`, `stash drop`). **Warn (5):** hardcoded storage paths, out-of-scope features, file-header essays, comments that narrate the change instead of the code, and live pages that narrate their own history (Rule 2). When the owner corrects the same thing twice, add a rule with `/hookify`. Start its `file_path` pattern with `^(?:.*/)?` before the directory name, because a repo-root anchor never matches the absolute path an edit passes, and the rule dies silently. There is no `not_regex_match` operator, and an unknown operator kills the whole rule (A55) |
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

## Conventions

- Docs are Markdown, `kebab-case.md`, ASCII-only prose. `§` for "section" is in wide use across
  `docs/`, and whether the rule allows it is open (A91).
- ADRs: `docs/decisions/ADR-NNNN-short-slug.md`, numbered in sequence and never renumbered once
  on `main`. Two branches can take the same next number and merge without a git conflict, since
  the filenames differ, and no check catches it: the branch that merges later renumbers its own.
  A superseded ADR is rewritten in place with the reversal recorded (see ADR-0004).
- The MVP is **TypeScript only**. No Rust, no C++ (ADR-0002).
- Prior material is quoted in English; the private planning docs are partly Italian.
