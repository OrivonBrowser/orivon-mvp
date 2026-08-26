# Repo openness and parallel work — design

**Status: design approved in outline by the owner 2026-08-26; awaiting review of this
document before an implementation plan is written.**

Two goals, given by the owner on 2026-08-26:

1. **A developer arriving at this repository alone, with no AI assistance, can start
   working.** This is a standing policy for the whole project, not a one-off task.
2. **Several Claude Code sessions can work at once without corrupting each other's work**,
   with either prevention of conflicts or a system that repairs them.

Everything below serves one of those two. Where a choice serves neither, it is out.

---

## Decisions taken

Recorded here because each is load-bearing and none is free to reverse later.

| # | Decision | Made by | Date |
|---|---|---|---|
| D1 | The repository is **fully public**, including the planning and strategy corpus, with full git history | Owner | 2026-08-26 |
| D2 | Published to **`github.com/OrivonBrowser/orivon-mvp`** | Owner | 2026-08-26 |
| D3 | Licence is **Apache-2.0**, copyright **Davide Martinico** | Owner | 2026-08-26 |
| D4 | Parallelism is enabled by a **types-only `src/contracts/`** plus directory ownership, *not* by an npm-workspaces refactor | Owner | 2026-08-26 |
| D5 | Streams integrate via **pull request, CI-gated, owner merges** | Owner | 2026-08-26 |

**D1 in full, so it is not later mistaken for an oversight.** `readiness.md`,
`audit-2026-08-25.md`, `mvp-scope.md` and `devlog/` contain the project's budget, its lack of
existing distribution presence, its honest download-funnel arithmetic, and candid internal
assessments of whether the core hypothesis is true. The owner chose to publish all of it.
Building in public is treated as a distribution channel, not a leak. The org already contains
an `internal-docs` repository if this is ever partially reversed.

**On D4.** An npm-workspaces monorepo gives a compiler-enforced boundary that a directory
convention cannot. It was rejected on cost: it reworks `electron.vite.config.ts`,
`tsconfig.json`, `scripts/check-no-native-modules.mjs` and CI during the tightest month of the
schedule, to buy enforcement of a boundary that four concurrent streams can hold by convention.
Revisit if the stream count exceeds roughly six, or if a boundary violation actually happens.

---

## Part A — the human path

### The problem

The only map of this project is `CLAUDE.md`, which is an agent instruction file. A human who
clones the repository today finds no `README`, no licence, no entry point, and eleven
directories under `docs/`. The project is well documented and simultaneously unnavigable,
because all of its navigation is addressed to a machine.

The fix is not more documentation. It is **moving the map into files a human looks for**, and
reducing `CLAUDE.md` to what is genuinely agent-specific.

### Root files to create

| File | Answers | Notes |
|---|---|---|
| `README.md` | What is Orivon, why does it exist, how do I run it, what works today | Must state honestly that this is pre-alpha at build step 1 of 10. Three-command quickstart. Links out to `docs/`, never duplicates it |
| `ARCHITECTURE.md` | How do the pieces fit together | One diagram (renderer → `orivon.*` → broker → OS), the directory-to-purpose map, and the single load-bearing idea from `ADR-0002`. Target: understandable in five minutes |
| `CONTRIBUTING.md` | How do I make a change that will be accepted | Setup, the eight rules from `CLAUDE.md`, branch and PR flow, which tests to run, the lockfile rule, commit style |
| `SECURITY.md` | How do I report a vulnerability | Not optional for software whose product *is* a permission broker |
| `LICENSE` | May I use this | Apache-2.0, copyright Davide Martinico |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 | Standard, cheap, expected on a public repo |
| `CHANGELOG.md` | What shipped when | Keep a Changelog format. Starts at "Unreleased" |

`package.json` changes: `"license": "Apache-2.0"` (currently `UNLICENSED`, which legally
forbids the clone-and-`npm start` path the build plan depends on), `"private"` stays `true`
(this is an application, not a published package), and `repository` / `bugs` / `homepage`
fields are added.

### A README in every meaningful directory

The highest-leverage item in Part A, and the one that most directly serves goal 1. Each
directory-level `README.md` answers exactly three questions in a few lines:

- **What lives here.**
- **What it depends on.**
- **What it must never import.**

That third line is what makes the directory tree self-enforcing rather than merely descriptive,
and it is also the ownership boundary that Part C relies on.

Directories to cover: `src/`, `src/main/`, `src/contracts/`, `src/preload/`, `src/renderer/`,
`docs/`, `scripts/`, `test/`, `spike/`, and each new stream directory as it is created.

`spike/` needs its README most: seven gate directories of working Electron code that is
**historical evidence, not live code**. A newcomer will otherwise read it as the project.

### docs/ changes

The existing `architecture/`, `decisions/` and `planning/` split is sound and stays. Two
additions:

- **`docs/README.md`** — the reading order, currently buried in `CLAUDE.md`. Distinguishes
  "read this to understand the product" from "read this to understand a decision" from "read
  this to start working".
- **`docs/development/`** — new, holding the material a contributor needs:
  - `setup.md` — prerequisites, install, run, the `ELECTRON_RUN_AS_NODE` trap
  - `testing.md` — what is tested and why so little is (per `build-plan.md` §Testing)
  - `parallel-work.md` — Part C of this document, as an operational guide
  - `release-checklist.md` — referenced by `build-plan.md` §Testing but **does not exist**;
    creating it closes a real gap, with a precondition, a fixed input and a falsifiable
    assertion per item
  - `readability-log.md` — Part D

### CLAUDE.md after the change

It keeps: the phase pointer, the tooling table, the eight rules, the `ELECTRON_RUN_AS_NODE`
warning, the devlog capture instruction, and the parallel-work protocol from Part C. It loses
the reading order and the sources-of-truth table, which move to `docs/README.md` and are
referenced from `CLAUDE.md` by link. No content is deleted; it is relocated to where a human
would look for it.

---

## Part B — `src/contracts/`

### What it is

Types only. No runtime code, no imports, no emitted JavaScript. It is the frozen interface that
every parallel stream codes against, so that streams which are *sequentially dependent in the
build plan* become *concurrently implementable*.

This is not new design work. `capability-api.md` §v0 surface and `handle-contracts.md` already
contain literal TypeScript interfaces, a closed error enum, a close/half-close semantics table
and a nine-item conformance checklist. **Part B is a transcription, and any place where
transcription proves impossible is a genuine gap in those documents that must be raised, not
invented around** (`CLAUDE.md` Rule 3).

### Files

```
src/contracts/
  index.ts             re-exports; the single import site for every consumer
  errors.ts            OrivonError, OrivonErrorCode (the closed enum)
  handles.ts           Handle, TcpSocket, TcpServer, UdpSocket, Datagram,
                       FileHandle, FileStat, IdentityHandle
  capability-api.ts    the orivon.* surface: app, net, fs, id
  manifest.ts          the /.well-known/orivon.json shape, Grant, GrantId
  ipc.ts               renderer <-> main message shapes and the credit-window
                       protocol from handle-contracts.md TcpSocket backpressure
  limits.ts            the per-origin defaults table (512 sockets, 64 file
                       handles, 256 in-flight, 1 MiB window)
```

### The two rules that make it safe to depend on

1. **Zero imports.** No `electron`, no `node:*`, no third-party types. `ReadableStream`,
   `WritableStream` and `Uint8Array` are ambient globals already available via
   `tsconfig.json`'s `lib: ["ES2023", "DOM", "DOM.Iterable"]`, verified 2026-08-26. Enforced by
   a test that scans `src/contracts/**/*.ts` and fails on any `import` or `require`, run in CI.
2. **Change-controlled.** A change to `src/contracts/` touches every stream at once, so it is
   the one place where coordination is mandatory: contract changes are **their own pull
   request, merged before any stream builds on them**. No stream may modify `src/contracts/` in
   the same PR as an implementation.

### Why this also serves goal 1

A developer who reads seven short files understands the entire product surface — what an app
can ask for, what it gets back, how failures are named, what the limits are. Per `ADR-0002`
that surface *is* the durable asset; the Electron shell beneath it is explicitly disposable.
Making the durable asset the most readable thing in the repository is the correct ordering.

---

## Part C — the parallel work system

### The underlying problem

`build-plan.md` is dependency-ordered: shell → broker → shim → app loader → torrent app. Step 3
cannot begin before step 2 exists. Parallelism is therefore not discovered, it is
**manufactured** — by freezing the interfaces (Part B) so a stream can build against a contract
and a stub instead of against another stream's half-finished code.

### Prevention

**1. Worktrees.** Each stream runs in its own checked-out directory on its own branch:

```
git worktree add ../orivon-broker  -b stream/broker
git worktree add ../orivon-telemetry -b stream/telemetry
```

Two sessions in two directories physically cannot write the same file. This is the primary
mechanism; everything else is a refinement of it. Claude Code supports worktrees natively, so
the mechanics cost nothing.

**2. The ownership map.** Lives in `docs/development/parallel-work.md`. Each stream owns a
disjoint set of paths and may not write outside them.

| Stream | Owns | Build step | Status |
|---|---|---|---|
| `shell` | `src/main/{window,tabs,omnibox,ipc}.ts`, `src/renderer/`, `src/preload/shell.ts` | 1 | done; maintenance only |
| `contracts` | `src/contracts/` | — | change-controlled, see Part B |
| `broker` | `src/broker/`, `src/broker/policy/`, `src/preload/app.ts` | 2 | critical path |
| `shim` | `src/shim/` | 3 | |
| `loader` | `src/loader/` | 4 | |
| `torrent-app` | `apps/torrent/` | 5 | ships as a pre-built app asset |
| `fixture-app` | `apps/fixture/` | testing | app #3, also the developer-mode example |
| `trust` | `src/trust/` | 6 | |
| `nostr` | `src/nostr/` | 7 | |
| `telemetry` | `src/telemetry/` | 8 | |
| `packaging` | `electron-builder` config, `scripts/` | 10 | independent of everything |
| `docs` | `docs/`, root markdown | — | always available |

`src/broker/policy/` is called out separately because `build-plan.md` §Week 0 already requires
it to hold pure functions with no Electron imports and no I/O, constructed as
`createBroker({ dial, resolve, now, fs, keychain })`. That property is what lets the broker's
security-critical logic be tested against stubs, and it is also what lets a second stream write
those tests concurrently with the broker being implemented.

**Realistically concurrent today:** `broker`, `packaging`, `telemetry`, `docs`. Four streams,
no path overlap.

**3. Contracts-first.** Stated in Part B; repeated in the operational guide because it is the
rule most likely to be forgotten under time pressure.

**4. Composition roots.** Two files are structural conflict magnets, because every stream must
register itself in them:

- `src/main/index.ts` — where each subsystem is wired into the app lifecycle
- `electron.vite.config.ts` — where each build entry point is declared

Both are restructured so that adding a subsystem **appends two lines** rather than editing
logic. Concretely: each subsystem exports a `register(ctx)` function, and `index.ts` holds a
list of registrations. Git merges appended lines in different positions of a list cleanly; it
does not merge two edits to the same conditional. This converts the worst conflict surface in
the repository into the mildest one, and it costs a few lines now versus a recurring tax later.

### Repair

Conflicts will still happen. Three mechanisms, in order of how often they will fire:

**1. `package-lock.json` — never hand-merge.** This is the most common parallel-work conflict
and the most dangerous, because a hand-merged lockfile can look correct and produce a broken or
subtly different dependency tree. The rule, written into `CONTRIBUTING.md`: take either side
wholesale, run `npm install`, commit the regenerated file. Never resolve it hunk by hunk.

**2. `.gitattributes` with `merge=union`** on genuinely append-only files:

```
devlog/journal.md   merge=union
CHANGELOG.md        merge=union
```

Git resolves these automatically by keeping both sides instead of stopping the merge. This is
correct *only* for files where every change is an append and order does not matter, which is
exactly what those two are. It must not be extended to source files, where union-merging
produces syntactically valid nonsense.

**3. CI as the semantic check.** A textual merge can succeed while the result does not compile
or does not pass. `.github/workflows/ci.yml` already runs typecheck, unit tests, the
native-module guard and a build on every push and pull request. Under D5 a PR cannot merge
until that is green. This is the mechanism that catches the class of conflict git cannot see,
and it is why `build-plan.md` says "with no code reviewer, CI is the reviewer".

### Integration flow

Per D5:

1. Stream branches from `main` in its own worktree: `stream/<name>`.
2. Work lands as commits on that branch. Rebase on `main` before opening the PR.
3. PR opened with a body stating: the goal, the paths touched, the contracts depended on, and
   how it was verified.
4. CI must be green.
5. Owner merges.

The pull requests are also the public record of the work, which is the "tracking and
publishing" half of goal 1: a reader sees not just the code but each unit of work and its
reasoning.

### Stream briefs

For a stream to be dispatched cleanly it needs a written brief: goal, owned paths, contracts
depended on, definition of done, and required tests. These live as **GitHub issues**, one per
stream task, labelled by stream and grouped into a milestone per build-plan week. That keeps
the brief and the public record in the same place rather than duplicating them.

---

## Part D — the readability test as standing policy

Goal 1 is a policy, not a task, so it needs a recurring check. The owner is the human in the
loop and has asked to be used as one.

**The protocol.** At the end of every build step, exactly one artefact is handed to the owner —
the document a newcomer would hit at that point in the project — with one question:

> Read this cold. Where is the first place you got lost, or had to guess?

Not "is this good?", which reliably returns a useless answer. The first point of confusion is
the fix list, and everything after it is unreliable because the reader is already lost.

**Recording.** Each check appends to `docs/development/readability-log.md`: the date, the
artefact, the first confusion point, and the fix made. Accumulating them is what turns
occasional feedback into a measurable property. It also gives a later contributor a record of
which parts of the documentation have actually been tested on a human.

**Durability.** The protocol goes into `CLAUDE.md` as a standing rule, so it survives an agent
losing context mid-project.

---

## Non-goals

Stated explicitly so they are not quietly added later.

- **No npm-workspaces refactor** (D4).
- **No rename of the local working directory.** It stays `orivon-mvp`. Renaming breaks the
  agent state paths under `~/.claude/projects/` and buys a person cloning the repository
  nothing.
- **No changes to `spike/`** beyond adding a README that marks it as historical evidence. The
  gate code is the evidence behind `spike-verdict.md` and must stay exactly as it was when
  measured.
- **No unrelated refactoring of the shell.** Build step 1 is done and works; the only change to
  it is the composition-root restructure in Part C, which is in service of parallelism.
- **No duplication of the vision corpus.** `orivon-docs` stays canonical and is linked, per
  `CLAUDE.md` §Sources of truth.
- **No CI expansion.** The existing four checks are the gate. Adding coverage targets or UI
  tests contradicts `build-plan.md` §Testing.

---

## Definition of done

1. A person who has never seen the project can clone it, run `npm install && npm run dev`, see
   a window, and explain from `README.md` and `ARCHITECTURE.md` what the software is trying to
   prove. Verified by Part D, on the owner, before this work is called complete.
2. `github.com/OrivonBrowser/orivon-mvp` exists, is public, carries the full history, and CI is
   green on `main`.
3. `src/contracts/` compiles, imports nothing, and the import-guard test passes in CI.
4. `docs/development/parallel-work.md` names every stream and its owned paths, and no two
   streams overlap.
5. Two streams can be dispatched in worktrees and merged through green PRs without a manual
   conflict resolution outside the lockfile rule.
6. `LICENSE` exists and `package.json` agrees with it.

---

## Risks

| Risk | Handling |
|---|---|
| The public corpus is quoted against the project (budget, "this might not work") | Accepted by the owner under D1. Building in public is the chosen posture |
| Directory ownership is a convention, not enforced by a compiler | Accepted under D4. Revisit at roughly six streams, or on the first actual violation |
| Transcribing `src/contracts/` surfaces gaps in the two specification documents | Expected, and the point. Gaps are raised in `open-questions.md` per Rule 3, never invented around |
| Time spent here is time not spent on the clip | Real. `readiness.md` says the owner's best use of the month is distribution. Mitigated by doing it now, at one build step landed, rather than after step 5 when the cost is several times higher |
| The composition-root restructure breaks build step 1 | The existing smoke check (`npm run smoke`) and `omnibox.test.ts` must both pass before that change merges |
| PR review becomes the bottleneck | A green, small PR takes seconds to approve. If it does bottleneck, D5 is cheap to relax to auto-merge |

---

## Open items — not decided, blocking or near-blocking

1. **The GitHub token cannot do this job.** `gh` authenticates from `GITHUB_TOKEN` exported at
   `~/.bashrc:164`, a classic PAT scoped `read:user` and `repo:status` only. Creating the
   repository, pushing, and opening pull requests all require `repo`; and because
   `.github/workflows/ci.yml` is tracked, **the first push fails without `workflow` scope**.
   While `GITHUB_TOKEN` is set in the environment, `gh auth login` and `gh auth refresh` are
   both ignored. Blocks D2 only — every other part of this design proceeds without it.
2. **Two dead repositories sit beside the live one.** The org already contains
   `orivon-browser` and `orivon-browser-v2`; the latter is the failed prior MVP that
   `CLAUDE.md` explicitly says is not a baseline. A person landing on
   `github.com/OrivonBrowser` and seeing three similarly-named repositories cannot tell which
   is alive, which directly defeats goal 1 before they ever reach this repository's README.
   **AI recommendation:** archive both and say so in the new README. Awaiting the owner.
3. **The two specification documents both say "DRAFT, needs owner review before any code is
   written."** `capability-api.md` and `handle-contracts.md` carry that header, and Part B
   transcribes them into code. Transcription is not implementation and does not require the
   review to have happened first — but the review is now on the critical path for build step 2,
   and is worth doing while the contracts are being written rather than after.

---

## Reference

- `docs/planning/build-plan.md` — the dependency order this design manufactures parallelism from
- `docs/architecture/capability-api.md`, `docs/architecture/handle-contracts.md` — the sources
  `src/contracts/` transcribes
- `docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md` — why the contracts, not the
  shell, are the thing to make readable
- `docs/planning/readiness.md` — the standing caveat about where the owner's month is best spent
