# Orivon MVP — agent operating instructions

## Start here

**Phase: build step 1 (the shell) complete. `src/contracts/` written and the parallel-work
system in place (2026-08-26). Next action is build step 2 (the capability broker) — nothing
blocks it.**
Last updated 2026-08-27 (code guidelines and the PR blueprint added as the third and fourth
standing rules, then applied to the whole codebase the same day across two branches --
`stream/backlog-06-rule2-violations` and `stream/backlog-07-guidelines-cleanup`).

**The human documentation is the map. Read it first — this file adds only what is specific to
working here as an agent.**

| | |
|---|---|
| `README.md` | What Orivon is, its status, its roadmap, how it relates to Web3 |
| `ARCHITECTURE.md` | How the pieces fit, which are disposable, and the owner's design choices |
| `docs/README.md` | **The documentation index** — three reading tracks and the sources-of-truth table |
| `docs/development/parallel-work.md` | **Read before starting any build step** |
| `docs/development/code-guidelines.md` | **Read before writing any code** — comments, the 500-line limit, one implementation per idea |
| `docs/development/pr-blueprint.md` | **Read before opening a PR** — the title rule, the seven sections, the labels |
| `src/contracts/` | The product surface in seven files. Faster than any prose |

That index is deliberately *not* duplicated here. Two copies drift, and the human one is the
one a contributor will actually find.

Three things load-bearing enough to repeat:

1. `docs/planning/audit-2026-08-25.md` records five independent audits, and **several documents
   carry corrections reversing their own earlier claims.** Where a document says two things,
   the correction block is the current one.
2. `docs/decisions/` — nine ADRs. Read before proposing anything architectural; most obvious
   ideas have already been considered and rejected for recorded reasons. **ADR-0002, ADR-0005
   and ADR-0009 carry amendments superseding parts of their own text; ADR-0008 rescopes
   ADR-0002's Node-shape-mirroring rule to the shim, not the capability layer; ADR-0009 fully
   specifies the bundle hash that ADR-0005/ADR-0006 already relied on — read its 2026-08-27
   amendment before its §Reasoning, which overstates the sort-order rule.**
3. `docs/mvp-scope.md` — **anything absent from the IN table is out by default.**

**The spike resolved.** Verdict and evidence: `docs/planning/spike-verdict.md` (read this, not
the older `week-0-spike-plan.md`, for current status). Gates 0/1a/1b/2 **PASS** with hard
evidence; gate 4 (throughput) fails its literal relative-to-native-control threshold but beats
the actual product requirement 10x — read past the verdict field; gate 3 (video playback) is
**BLOCKED**, not failed — the app works (confirmed via a direct, non-Playwright launch), but
Playwright's `_electron` driver can't attach to that window, for an unidentified reason. This
is a real, currently-unresolved risk for build step 2's e2e test, which uses the same driver —
check early. **`utilityProcess` fallback was not needed.**

**Narrowed at build step 1 (2026-08-26):** a minimal `BaseWindow` with multiple
`WebContentsView`s (the shell's actual composition) attaches to `_electron` cleanly — so the
cause is specific to gate 3's video/service-worker setup, not `BaseWindow` in general. Practical
consequence: once a window holds more than one view, match windows by URL via `app.windows()`,
never `app.firstWindow()` (view-add order is an implementation detail, not a contract) —
`open-questions.md` C6, `scripts/smoke.mjs` for the pattern in use.

**This machine has `ELECTRON_RUN_AS_NODE=1` set in the ambient shell environment.** It makes
the Electron binary run as plain Node — no windows, no `MessagePortMain`. It does not fail
loudly. Never launch Electron directly; see `.claude/skills/orivon-electron/` for the pattern
that strips it and verifies the launch is real.

**Electron's `.d.ts` sometimes types an option/event on `BrowserWindow` only, even when it
works identically on `BaseWindow`** (`ready-to-show`; the `titleBarStyle`/`titleBarOverlay`/
`trafficLightPosition` family). context7's docs are silent on `BaseWindow` for these rather
than wrong — confirmed both work via a throwaway probe app, 2026-08-26. When context7 doesn't
confirm something specifically for `BaseWindow`, verify empirically before assuming either way.

Open owner decisions are in `docs/open-questions.md` §A. A11 is closed (`ADR-0007`: cached
bundles keep their real origin, intercepted inside the app's partition). **A10 is closed**
(`docs/architecture/handle-contracts.md`, `ADR-0008`): WHATWG streams underneath, Node shapes
presented by the shim on top, full specification written — the closed error enum, close/half-
close semantics, a credit-window backpressure design, and the revocation cascade. Build step 2
is unblocked.

## What this repository is
The MVP implementation of **Orivon**. It is *not* the vision documentation.

The MVP proves one thing: that a browser can run applications **impossible in Chrome** —
reaching the network and filesystem under user-granted, per-app capabilities — while those
applications are ordinary web frontends delivered from a URL.

Success metric: **100 active users in EU/USA, active = 25 h/month.** The metric, not the
long-term vision, decides scope.

## Sources of truth

**In `docs/README.md`.** Not repeated here — see the note in §Start here.

Two things that are agent-specific and belong in this file rather than that one:

- **The long-term vision lives at `/home/jhon/Desktop/Develop/orivon-docs/docs/`** (canonical,
  deployed at docs.orivonstack.com). **Do not duplicate it into this repository** — summarise
  and link. This repo is deliberately narrower.
- **`docs/inventory.md` indexes all prior material. Do not re-crawl the filesystem** looking
  for it.

`/home/jhon/git/orivon-browser-v2` is a **failed prior MVP**. Not a baseline, not a reference
architecture. Its GUI may be used as *visual reference only*.

## The load-bearing idea

The durable asset is the **capability API** (`orivon.*`), now written as types in
`src/contracts/`. The Electron shell beneath it is knowingly disposable.

The interface is designed so the implementation underneath could change — a WASM runtime, or
IPC inside a browser engine — without any app already written having to change.

> **State this carefully, and never as a roadmap.** The owner flagged the earlier wording
> (readability check 1, 2026-08-26) for implying this repository is on its way to becoming a
> browser-engine fork. It is not. A WASM runtime and an engine fork are **explicitly out of
> scope** (`mvp-scope.md` §LATER), nobody is working on either, and nothing here depends on
> them happening. The engine-independence is a *property of the design* that costs nothing
> today — not a plan. `orivon-runtime` is deferred, not cancelled; its jobs are containment for
> untrusted code and mobile portability, both post-MVP.

**Practical consequence:** a shortcut in `src/main/` costs a refactor of code that was
replaceable anyway. A shortcut in `src/contracts/` costs every app ever written for Orivon.

## Rules
1. **Do not silently promote assumptions into architecture.** If a choice is load-bearing and
   reversible only at cost, write an ADR (`docs/decisions/ADR-0000-template.md`).
2. **Label uncertainty explicitly.** Distinguish owner's decision / AI recommendation / still
   open. Never blur them.
3. **Contradictions get surfaced, not smoothed over.** Append to `docs/open-questions.md` and
   raise it with the owner.
4. **Scope discipline.** The vision corpus is large, coherent and seductive, and the developer
   is solo — scope creep out of it is the single biggest risk. **Anything absent from the IN
   table in `mvp-scope.md` is out by default.**
5. **Label every component disposable or durable.** Say, per component, whether it is tied to
   Electron or would outlive it — `ARCHITECTURE.md` has the current table. This is about
   spending care in the right place, **not** about a planned migration; see §The load-bearing
   idea before writing anything that sounds like a roadmap.
6. **Prefer mature components.** Per subsystem decide: build / library / fork / embed /
   interface. Do not reinvent without a written reason.
7. **Don't over-document trivia**, and don't create abstractions for elegance alone. In code
   specifically, this is Rule 1 of `docs/development/code-guidelines.md` — see §Code guidelines.
8. **Pure-JS dependencies only.** Native modules break run-from-source on Windows and macOS,
   which is a supported path (`build-plan.md`).

## Four standing rules, all owner policies

Parallel work and the readability check are from 2026-08-26; the code guidelines and the PR
blueprint from 2026-08-27.

### The PR blueprint

**Read `docs/development/pr-blueprint.md` before opening a pull request.** GitHub pre-fills
`.github/pull_request_template.md` for you, so in practice this is filling in a form that is
already there — but the blueprint carries the reasoning and the anti-patterns, and it is the
copy that wins if the two ever disagree.

- **Title:** imperative, present tense, **no prefix**, about 72 characters. The stream is
  carried by the label and the branch name; repeating it in the title wastes list-view
  characters. Name a *change*, not a noun.
- **Body:** seven sections — what changes for the user, goal, what it achieves, how it works,
  stream/paths/merge order, decisions and open questions, how it was verified. Two optional:
  risk and rollback, deliberately not done. A `type:chore` or one-line fix may keep only goal,
  user impact and verification; anything on the critical path takes the full form.
- **Labels:** one `stream:`, one `type:`, one `ux:`, plus `contracts-change` or
  `needs-owner-decision` if they apply.

Three failure modes worth naming, because an agent will hit all three:

1. **Do not invent a user impact.** Most PRs here change nothing anyone experiences.
   `None — <why>, and here is when it will be visible` is the expected answer and a respected
   one. "Improves security" names a category, not an effect.
2. **Every claim under *how it was verified* must be something you ran**, in this tree, on this
   branch. Paste the actual numbers. If a check was skipped, say so and why — a silently omitted
   check reads as a passed one.
3. **`Decisions and open questions` is Rules 1 and 2 at PR level.** Label each entry owner's
   decision / AI recommendation / still open, and list any `open-questions.md` A-numbers filed,
   taken from **main's** highest rather than your branch's.

Nothing enforces this mechanically, by owner's decision — same call as the code guidelines. The
template does the work by being already in the box. Note it is bypassed entirely by
`gh pr create --body`, which is exactly how an agent tends to open one.

### Code guidelines

**Read `docs/development/code-guidelines.md` before writing any code.** The three rules, in
short — the document carries the full reasoning and the worked examples:

1. **Comments earn their place.** A comment explains *why*; the code already says *what*. If it
   restates the line below it, delete it. Long comments are allowed where length is genuinely
   what makes a section understandable — not by default. Plain language: the reader may be new
   to the project or a model with a small context window. **Carve-out:** doc comments on
   exported declarations in `src/contracts/` are exempt — they are the product's documentation.
   Inline comments inside function bodies are not exempt anywhere.
2. **500 lines for source, 800 for tests** (`*.test.ts`, `test/`, `scripts/smoke.mjs`). Split by
   concern, never by line count — `foo-part2.ts` is worse than the long file. The limit exists so
   a smaller model can hold a whole file and reason about it confidently.
3. **One implementation per idea.** Before writing a helper, `grep -rn "function <name>" src/`.
   Extract when the *reason* is shared, not when the shape is (Rule 7 still applies).

**Applied to the whole codebase 2026-08-27**, across two branches: `stream/backlog-06-rule2-
violations` (the two files that had already broken Rule 2 — `handles.ts` at 1045 lines,
`connect.ts` at 622 — plus their test files) and `stream/backlog-07-guidelines-cleanup` (the four
that were close enough to break it next, the comment cuts, and eight Rule-3 duplicates including
the `concat`/`encodeField` pair this rule was written from). Every source file is now under 500
lines and every test file under 800; `docs/development/code-guidelines.md` §Where the codebase
stands has the full before/after per file. Two known duplicates (a hex encoder, the
`MAX_HOST_LENGTH`/`MAX_PORT` constants) were found and deliberately left for a follow-up rather
than fixed mid-refactor, because both cross into files the other branch was restructuring at the
same time — see that document's Open Points §3.

**`src/shared/` exists for a helper needed on both sides of a trust boundary** — `src/broker/`
and `src/shim/` may not import each other, and `check:contracts` rules out `src/contracts/`. It
is **change-controlled like contracts** (own PR, merges first) and **imports nothing**. Still
empty: the audit above confirmed nothing in the current tree actually crosses that boundary.

**Nothing enforces these mechanically, by owner's decision (rules first, enforcement later).**
No linter or formatter exists. The one place conventions had already drifted — 14 declarations in
`derive.ts` and its test written `function name(args)` against 115 elsewhere written
`function name (args)` — was normalised as part of the 2026-08-27 refactor. A **second** such
split is the signal the deferral has expired.

### Parallel work

**Read `docs/development/parallel-work.md` before starting any build step.** Then:

- Work in a **worktree** on `stream/<name>`, matching the ownership map.
- **Stay inside your owned paths.** If a change needs a file another stream owns, that is a
  signal — raise it, do not just edit it.
- **Never modify `src/contracts/` in the same PR as an implementation.** A contracts change
  touches every stream at once; it goes in its own PR and merges first.
- **Append at the append points** (`src/main/subsystems.ts`, the preload input map) rather than
  editing shared logic. Do not add logic to `subsystems.ts`.
- **Never hand-merge `package-lock.json`.** Take either side whole, run `npm install`, commit
  the result.

### The readability check

**At the end of every build step**, hand the owner **exactly one artefact** — the document a
newcomer would hit at that point — and ask:

> *Read this cold. Where is the first place you got lost, or had to guess?*

**Not "is this good?"**, which reliably returns a useless answer. And only the *first* point:
everything after it is unreliable, because the reader is already reconstructing from context.

Record the date, artefact, confusion point and fix in `docs/development/readability-log.md`.
**This does not lapse**, and it is a gate rather than a courtesy — the first round caught a
missing roadmap, an unexplained Web3 relationship, and an `ARCHITECTURE.md` section that
actively implied the wrong thing.

Lessons from the first rounds, now binding on anything written here:

- **State omissions as omissions, with reasons.** Two README findings were absences, not
  errors — and the reader could not tell "deliberately out of scope" from "not thought about".
- **Never state an MVP scope boundary as a permanent property of Orivon, and never state a
  long-term aspiration as a plan for this repository.** This was caught twice, in opposite
  directions: `ARCHITECTURE.md` implied this repo was becoming a browser-engine fork (it is
  not — that is out of scope), and `README.md` said "not a wallet, no DAO, there won't be one"
  when **both are real long-term goals** with their own designs in the vision corpus
  (`wallet-system.md`, `dao-plan.mdx`); only *this MVP* excludes them.

  Every sentence about scope must make clear **which** thing it bounds — this month's build,
  this repository, or the project. A reader cannot recover that from context and will believe
  whichever the sentence implies. Both errors read as confident and precise; neither was.

## Tooling — what fires when (installed 2026-08-25, `.claude/settings.json`)

Plugins are project-scoped and travel with the repo. Some are automatic, the rest must be
invoked at the step named here. **Check this table at the start of every build step.**

| Tool | Fires | Use it for |
|---|---|---|
| `npm run check:contracts` | **CI, and on demand** | Fails if `src/contracts/` is incomplete or references anything outside itself. A sibling (`./errors.js`) is fine; `electron`, `node:*` or any package is not |
| `npm run check:natives` | **Automatic on `postinstall`, and CI** | Rule 8. Fails if any dependency needs a compiler at install time |
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main / preload / renderer. Trust its diagnostics over your own reading of a type |
| `security-guidance` | Automatic: warns on edits, reviews the diff when you stop, reviews every `git commit` | Path traversal (T1/T10), SSRF / private-address (T12), secrets. Address or explicitly acknowledge every finding |
| `hookify` rules in `.claude/hookify.*.local.md` | Automatic on edits and shell | Block native modules (Rule 8), insecure `webPreferences`, non-TypeScript sources (ADR-0002); warn on hardcoded storage paths (ADR-0003) and out-of-scope features (Rule 4). Add a rule with `/hookify` whenever the owner corrects the same thing twice |
| `superpowers` | Process, automatic via its session hook | `brainstorming` before new work, `writing-plans` for anything multi-step, `test-driven-development` for every broker / policy function, `systematic-debugging` on any failure, `verification-before-completion` before claiming done |
| `context7` (MCP) | **Manual — call it before writing code against Electron or webtorrent APIs.** | `protocol.handle`, `utilityProcess`, `MessagePortMain`, `WebContentsView`, `session` partitions, `safeStorage`; **webtorrent 3.x** internals and its `browser` field. Training data is stale here — a live check on 2026-08-25 found four wrong assumptions in the docs, including the version itself (`week-0-spike-plan.md` §Verified facts) |
| `playwright` (MCP) | **Manual — build steps 4 and 7.** | Drive the localhost fixture app (step 4) and the three pinned Nostr web clients (journey 3, step 7). The Electron e2e uses the `_electron` library, not this |
| `claude-security` | **Manual — run `/claude-security` at the end of build step 2 (broker) and again before packaging (step 10).** | Whole-repo multi-agent vulnerability scan with verified findings. Expensive: twice, not continuously |
| `claude-md-management` | **Manual — `/revise-claude-md` at the end of any session that changed an assumption in this file.** | Keeps this file true once code exists |
| `orivon-electron` (project skill) | **Manual — read before writing or debugging any Electron+webtorrent code.** | The renderer-bundling alias recipe, the `ELECTRON_RUN_AS_NODE` trap, `MessagePortMain` silent-failure behaviour, and the unresolved Playwright attach issue. Captured 2026-08-25; exists nowhere else |
| `adversarial-reviewer` (user skill) | Manual — after each build step lands | The multi-perspective review that produced `audit-2026-08-25.md`; run it on the broker and the app loader at minimum |
| Built-ins `/code-review`, `/security-review`, `/simplify` | Manual | Per-diff review before each commit on the critical path |

## Devlog capture
`devlog/journal.md` feeds the Sunday team devlog (compiled by `/devlog`). At the end of
any session where something notable happened — a milestone reached, a decision taken or
reversed, a direction change, a worry or idea the owner kept returning to — append a
dated one-liner to the current week's section (**Done / results** for outcomes,
**In my head** for thinking). Skip routine sessions; one line per notable thing, no prose.

## Conventions
- Docs are Markdown, `kebab-case.md`, ASCII-only prose.
- ADRs: `docs/decisions/ADR-NNNN-short-slug.md`, monotonically numbered, never renumbered.
  Superseded ADRs are rewritten in place with the reversal recorded (see ADR-0004).
- The MVP is **TypeScript only**. No Rust, no C++ (`ADR-0002`).
- Prior material is quoted in English; the private planning docs are partly Italian.
