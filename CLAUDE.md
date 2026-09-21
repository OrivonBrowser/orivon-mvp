# Orivon MVP — agent operating instructions

**The human documentation is the map. This file only adds what is specific to working here as
an agent.**

| Read | Before |
|---|---|
| `README.md` | anything — what Orivon is, its status, its roadmap |
| `ARCHITECTURE.md` | proposing a design — how the pieces fit, and which are disposable |
| `docs/README.md` | hunting for a document — it is the index and the sources-of-truth table |
| `src/contracts/` | writing against the API — the product surface in seven files, faster than any prose |
| `docs/development/parallel-work.md` | starting a build step |
| `docs/development/code-guidelines.md` | writing code |
| `docs/development/pr-blueprint.md` | opening a PR |
| `docs/decisions/decision-log.md` | asking *why* or *who decided* — pages do not carry that |

**Every page states only what is true now**, except the change records Rule 2 lists. It will not
tell you that it changed, or who decided it: that is git, the decision log and the ADRs. **ADRs are the exception**
and still carry their amendments in place, because an ADR is itself a decision record; nine of
the eighteen carry one, and where an ADR contradicts itself the amendment is the current text.

## Status — 2026-09-16

Build steps 1-4 are done: shell, capability broker, node shim, app loader. A person can install
an app from a URL, read one consent dialog before any of the app's code runs, grant capabilities,
and revoke them afterwards from a permissions panel. The owner's framing that day: *"the
permission engine is roughly 90% done, and everything finally sits in one place to start building
actual apps on."* Build step 5, the flagship torrent app, is next.

`id.requestIdentity` is the only unbuilt row left in the capability surface, and `window.nostr`
(step 7) is blocked on it (A111). Steps 5, 6, 8, 9 and 10 are open.

**For what works today read `docs/planning/compatibility-matrix.md`, not this section.** It is
re-derived from the tree rather than from PR bodies, and its Table 6 gives the recipe. It scores
each capability in four columns because **a module existing is not the same fact as a page being
able to reach it** (A151).

## What this repository is

The MVP implementation of **Orivon** — not the vision documentation.

It proves one thing: that a browser can run applications **impossible in Chrome** — reaching the
network and filesystem under user-granted, per-app capabilities — while those applications
remain ordinary web frontends delivered from a URL.

Success metric: **100 active users in EU/USA, active = 25 h/month.** The metric decides scope,
not the long-term vision.

- **The vision corpus lives at `<vision-corpus>`** (canonical,
  deployed at docs.orivonstack.com). Summarise and link — **never copy it into this repository**,
  which is deliberately narrower.
- **`docs/inventory.md` indexes all prior material. Do not re-crawl the filesystem for it.**
- **`<prior-mvp>` is a failed prior MVP.** Not a baseline and not a
  reference architecture; its GUI is a *visual* reference only.

## The load-bearing idea

The durable asset is the **capability API** (`orivon.*`), written as types in `src/contracts/`.
The Electron shell beneath it is knowingly disposable, and the interface is designed so the
implementation underneath could change without any app already written having to change.

**Practical consequence: a shortcut in `src/main/` costs a refactor of code that was replaceable
anyway. A shortcut in `src/contracts/` costs every app ever written for Orivon.**

> **Never write this as a roadmap.** A WASM runtime and an engine fork are explicitly out of
> scope (`mvp-scope.md` §LATER), nobody is working on either, and nothing here depends on them.
> The engine-independence is a *property of the design*, not a plan. `orivon-runtime` is
> deferred, not cancelled. The owner has more than once flagged wording that blurred this.

## Rules

1. **Do not silently promote assumptions into architecture.** If a choice is load-bearing and
   reversible only at cost, write an ADR (`docs/decisions/ADR-0000-template.md`).
2. **A page says how Orivon works now: never who decided it, and never how it got there.**
   Provenance — the date, the decision ID, who took it — goes in `docs/decisions/decision-log.md`
   or an ADR, never inline in the prose. **So does change history.** None of these belong in a
   page: "what changed since the last derivation", "was X, now Y", "moved from ❌ to ✅", "the
   first version did...", "corrected <date>", "added <date>", PR numbers, "this lane / this run /
   this pass", struck-through rows, "moved here from its header". A newcomer needs the current
   state; git, `CHANGELOG.md` and the decision log hold how it got there. A rejected alternative
   may stay as rationale when stated as a reason ("gating on X would race"), never as a story. A
   settled thing is just how it works. The one status a page must still carry is *provisional*:
   never present an unconfirmed call as settled, and say what would settle it.
   **Pages whose subject is change keep their history**, and only these: `CHANGELOG.md`,
   `docs/decisions/`, `docs/open-questions.md` (each entry's status and date),
   `docs/development/readability-log.md`, `docs/development/review-coverage.md`, `devlog/`, and
   the records under `docs/planning/`: every file there except `build-plan.md` and
   `compatibility-matrix.md`, which describe the present and follow this rule.
3. **Surface contradictions, never smooth them over.** Append to `docs/open-questions.md`. When a
   page turns out to be wrong, **rewrite it to be right** rather than appending a correction
   block beneath the wrong text — the page states what is true now, and the change earns a row
   in the decision log.
4. **Scope discipline. Anything absent from `mvp-scope.md`'s IN table is out by default.** The
   vision corpus is large, coherent and seductive, and the developer is solo — scope creep out
   of it is the single biggest risk this project has.
5. **Label every component disposable or durable** — say whether it is tied to Electron or
   would outlive it. `ARCHITECTURE.md` has the table. This is about spending care in the right
   place, not about a planned migration.
6. **Prefer mature components.** For each subsystem, decide: build, use a library, fork, embed,
   or define an interface. Do not reinvent without a written reason.
7. **Don't over-document trivia**, and don't create abstractions for elegance alone.
8. **Pure-JS dependencies only.** Native modules break run-from-source, which is how Windows
   and macOS are supported (`docs/planning/build-plan.md` §Platform policy).
9. **Say which scope a sentence bounds** — this build, this repository, or the project. Never
   state an MVP boundary as a permanent property of Orivon, and never state a long-term
   aspiration as a plan for this repository. A reader cannot recover which you meant from
   context, and will believe whichever the sentence implies. Two worked examples, both real
   mistakes made here: `docs/development/readability-log.md` §What these rounds changed.

## Working here

Four owner policies. Nothing below is a suggestion.

### Before starting a build step — parallel work

Read `docs/development/parallel-work.md`. Its "If you are an agent" section is the checklist,
and its numbered rules cover worktrees, path ownership, contracts and `src/shared` PRs, the
append points, and `package-lock.json`. Four things it does not cover:

- **A new worktree needs `node_modules`**: `ln -s <repo>/node_modules <worktree>/node_modules`.
- **A stacked PR needs a base ref the native worktree tool cannot take** — it only branches from
  `origin/<default>` or current HEAD. Use `git worktree add <path> -b <branch> <base>` instead.
- **Branch protection is `strict`:** merging PR N+1 always needs a fresh `main`-merge into its
  branch first, even when it touches none of N's files.
- **Syncing `main` with `origin`** — the procedure below.

**Syncing `main`, owner's decision 2026-09-15.** Never a bare `git pull`: it refuses to run on a
dirty tree, and the obvious recoveries (`git checkout -- .`, a badly resolved rebase) destroy the
uncommitted work silently. Check first with `git fetch origin --prune`, then
`git rev-list --left-right --count main...origin/main`.

- **Clean tree — sync unprompted.** `git merge --ff-only origin/main`. Never a merge commit,
  never `--force`.
- **Dirty tree — report, do not act.** Say which files are dirty locally **and** changed
  upstream; that is where conflicts come from. If told to go ahead: back the tree up outside the
  repo first — `git diff > <scratch>/uncommitted.patch` **plus** a tarball, since no stash
  captures untracked files — then stash, `--ff-only`, `git stash pop`. A conflict keeps the
  stash, so nothing is lost.

Afterwards run `npm run typecheck` and `npm run check:contracts`, plus `npm install` if
`package-lock.json` moved. **Re-read anything that auto-merged**: it can be textually clean and
semantically stale on its new base.

### Before writing code — code guidelines

Read `docs/development/code-guidelines.md`. Three rules: **comments earn their place**, **no
source file over 500 lines** (800 for tests), **one implementation per idea**. That page says
outright that its §Rules 1-3 is all you need in order to write code here and everything below is
background, and its §Status is the current enforcement state — read those two and nothing else.

### Before opening a PR — the PR blueprint

**Open one or two PRs per working day, not one per feature** — owner's decision `d-0033`,
2026-09-17. This is an **agent rule and lives here on purpose**: a human contributor sending one
change still opens one PR, so `CONTRIBUTING.md` and the PR template say nothing about cadence.
The reason is volume — continuous AI work merged 423 PRs over 17 days here, about 25 a day, and
nobody reviews that.

- Default to one PR for the day; open a second when the day splits into two unrelated themes, or
  when one body would be too tangled to follow.
- `stream/` branches and worktrees are unchanged — they converge into the day's PR instead of
  each opening their own.
- **`src/contracts/` and `src/shared/` are the one carve-out**, still alone and merged first. A
  day that touches contracts has an extra PR; that is expected, not a slip.
- **State what the size costs.** A day PR is harder to revert and harder to bisect. `## Changes`
  must make each piece separately findable, and `## How it was verified` must cover the whole
  day, not the last thing touched. A day PR whose body is one paragraph is worse than the
  twenty-five it replaced.

Read `docs/development/pr-blueprint.md` for the shape itself — the title rule, the five body
sections, labels, and the anti-patterns an agent actually hits. Its §Where the three copies live
settles precedence: that document is canonical and `.github/pull_request_template.md` derives
from it.

Worth knowing before you get there, because it is what stops you reading the rest: **a PR opened
with `gh pr create --body` bypasses the template entirely, and nothing will say so.** Use
`--body-file`, and see §Local quirks for the `gh pr edit` and labelling workarounds.

### At the end of a build step — the readability check

Give the owner one document — the one a newcomer would hit at that point — and ask only this:

> *Read this cold. Where is the first place you got lost, or had to guess?*

Record the answer in `docs/development/readability-log.md`, which has the full method in its
§The protocol. This happens at **every** build step, and "nothing confused me" is a real result
that still gets logged.

## Local quirks

- **`gh pr edit` fails with a GraphQL "Projects (classic)" error**, as does `--label` on
  `gh pr create`; this is unrelated to auth or content. Creating a PR is fine — plain
  `gh pr create --title ... --body-file ...` with no `--label` works. To edit an existing body,
  use `gh api -X PATCH repos/OrivonBrowser/orivon-mvp/pulls/<n> -F body=@file` (`-F` reads the
  file; `-f` would send the literal string `@file`). To label one, use
  `gh api -X POST repos/OrivonBrowser/orivon-mvp/issues/<n>/labels -f labels[]=<label>`.
- **`ELECTRON_RUN_AS_NODE=1` is set in this machine's ambient shell**, which turns the Electron
  binary into windowless plain Node without erroring. Every launch must go through
  `scripts/run-headless.mjs`; the hookify rule that blocks anything else explains why, and
  `.claude/skills/orivon-electron/` has the rest.

## Tooling — what fires when (`.claude/settings.json`)

Plugins are project-scoped and travel with the repo. Some are automatic; the rest must be invoked
at the step named here. **Check this table at the start of every build step.**

| Tool | Fires | Use it for |
|---|---|---|
| The `npm run check:*` gates | **CI, and on demand** | Ten of them, all run by CI: `check:contracts` (`src/contracts/` complete and referencing only its own siblings — `./errors.js` is fine, `electron`, `node:*` or any package is not), `check:natives` (Rule 8, also on `postinstall`), `check:size` (Rule 2), `check:comments` (Rule 1), `check:secrets`, `check:questions` (no duplicate A-number), `check:vectors`, `check:manifest-parity`, `check:dev-grant-absent`, `check:advisories` |
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main / preload / renderer. Trust its diagnostics over your own reading of a type |
| `security-guidance` | Automatic: on edits, when you stop, and on every `git commit` | Path traversal (T1/T10), SSRF / private-address (T12), secrets. Address or explicitly acknowledge every finding |
| `hookify` rules in `.claude/hookify.*.local.md` | Automatic on edits and shell | Thirteen rules. **Block (8):** native modules (in code and in `package.json`), insecure `webPreferences`, non-TypeScript sources, any Electron launch that bypasses `scripts/run-headless.mjs` or could steal window focus, in-place branch switches (`git pull`/`checkout`/`switch`, `gh pr checkout`) and tree-wide discards (`reset --hard`, `clean -f`, `stash drop`). **Warn (5):** hardcoded storage paths, out-of-scope features, file-header essays, comments that narrate the change rather than the code, and live pages that narrate their own history (Rule 2). Add a rule with `/hookify` whenever the owner corrects the same thing twice. Writing one: anchor `file_path` as `^(?:.*/)?(?:src|...)/`, since a repo-root anchor never matches an absolute path and the rule dies silently; and there is no `not_regex_match` operator — an unknown operator kills the whole rule (`docs/open-questions.md`) |
| `superpowers` | Process, automatic via its session hook | `brainstorming` before new work, `writing-plans` for anything multi-step, `test-driven-development` for every broker / policy function, `systematic-debugging` on any failure, `verification-before-completion` before claiming done |
| `context7` (MCP) | **Manual — before writing code against Electron or webtorrent APIs** | `protocol.handle`, `utilityProcess`, `MessagePortMain`, `WebContentsView`, `session` partitions, `safeStorage`; webtorrent 3.x internals. Training data is stale here — a live check once found four wrong assumptions in the docs, including the version number |
| `playwright` (MCP) | **Manual — the localhost fixture app, and journey 3's pinned Nostr clients (step 7)** | Driving a real web page. The Electron e2e uses the `_electron` library, not this |
| `claude-security` | **Manual — before packaging (step 10)** | Whole-repo multi-agent vulnerability scan with verified findings. Expensive: run it at milestones, not continuously |
| `claude-md-management` | **Manual — `/revise-claude-md` at the end of any session that changed an assumption in this file** | Keeps this file true as the code moves |
| `orivon-electron` (project skill) | **Manual — before writing or debugging any Electron+webtorrent code** | The renderer-bundling alias recipe, the `app.windows()`-not-`app.firstWindow()` rule, `MessagePortMain`'s silent failures, and why to check `electron.d.ts` before trusting any claim about `BaseWindow` options. Exists nowhere else |
| `orivon-comments` (project skill) | **Manual — before writing or editing a comment in `src/`** | Where rationale goes when it is not a "you will break this line" comment, and how to handle a header over budget |
| `adversarial-reviewer` (user skill) | **Manual — after each build step lands** | The multi-perspective review that produced `docs/planning/audit-2026-08-25.md`. Run it on the broker and the app loader at minimum |
| `/code-review`, `/security-review`, `/simplify` | Manual | Per-diff review before each commit on the critical path |

## Devlog capture

`devlog/journal.md` feeds the Sunday team devlog (compiled by `/devlog`). At the end of any
session where something notable happened — a milestone, a decision taken or reversed, a direction
change, a worry the owner kept returning to — append a dated one-liner to the current week's
section: **Done / results** for outcomes, **In my head** for thinking. Skip routine sessions. One
line per notable thing, no prose.

## Conventions

- Docs are Markdown, `kebab-case.md`, ASCII-only prose.
- ADRs: `docs/decisions/ADR-NNNN-short-slug.md`, monotonically numbered, never renumbered. A
  superseded ADR is rewritten in place with the reversal recorded (see ADR-0004).
- The MVP is **TypeScript only**. No Rust, no C++ (ADR-0002).
- Prior material is quoted in English; the private planning docs are partly Italian.
