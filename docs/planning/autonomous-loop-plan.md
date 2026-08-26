# Autonomous build loop — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use
> checkbox syntax.

**Goal:** build the system specified in `autonomous-loop-design.md` — a cron-driven loop that
dispatches parallel agents toward MVP goals, queues questions instead of blocking, opens PRs
without ever merging, and survives usage-limit exhaustion.

**Architecture:** Seven components, built bottom-up so each is verifiable alone. The
**selection policy is a pure function** with unit tests — it encodes decision L3 and is the one
piece where a silent bug wastes hours of unattended compute. Everything above it is plumbing.

**Spec:** `docs/planning/autonomous-loop-design.md`. Read it first; it records the six
decisions this implements.

## Global constraints

- **No new dependencies.** Node built-ins and `curl` only (Rule 8). The dashboard is a plain
  `node:http` server; the board is JSON on disk.
- **No secret ever enters the repository.** Credentials live in `~/.config/orivon/notify.env`,
  mode 600. The repo is public. Task 1 adds a CI guard so this cannot regress.
- **TypeScript for anything under `src/`.** `orchestration/` is `.mjs` — it is tooling, not
  product, matching `scripts/`.
- **The loop may never edit its own guardrails:** `orchestration/loop.sh`,
  `orchestration/*-settings.json`, `.claude/**`, the crontab, `~` dotfiles.
- **The loop never merges.** Branch protection enforces this independently.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Task 1: Notification, and a guard so the token cannot leak

**Files:** create `orchestration/notify.sh`, `scripts/check-no-secrets.mjs`,
`scripts/check-no-secrets.test.ts`; modify `.gitignore`, `package.json`,
`.github/workflows/ci.yml`

- [ ] **Step 1: Write the secret-scan guard test**

Mirrors the house guard shape: exported pure function over a root, tmpdir fixtures, CLI block.
Patterns to detect: Telegram bot tokens (`\d{8,10}:AA[\w-]{33}`), GitHub tokens
(`gh[pousr]_[A-Za-z0-9]{36,}`), AWS keys (`AKIA[0-9A-Z]{16}`), private-key headers, and
`Bearer` followed by a long opaque string.

Must NOT flag: the *patterns themselves* as written in the guard source, documentation that
describes a token shape, or a `.env.example` with placeholder values.

- [ ] **Step 2: Implement `scripts/check-no-secrets.mjs`**

Scans **git-tracked files only** (`git ls-files`), skipping its own source and
`docs/planning/autonomous-loop-plan.md`. Exports `checkNoSecrets(root)` returning
`{ ok, findings }` where each finding is `{ file, line, kind }` — **never the matched value**,
since the guard's own output must not leak the secret.

- [ ] **Step 3: Write `orchestration/notify.sh`**

Reads `~/.config/orivon/notify.env`. Backends: `telegram` (default), `ntfy`, `none`. Exits 0
when unconfigured — a missing notifier must never fail a build cycle. Usage:
`notify.sh <urgency> <message>`, urgency in `blocking|review|failure|idle`.

Message format, one line, under 200 chars, leading with what the owner would act on:
`[orivon] review: PR #14 broker-03 ready` — not `task done`.

- [ ] **Step 4: Wire in and verify**

`.gitignore` gains `orchestration/state/`, `*.env`, `!*.env.example`. `package.json` gains
`check:secrets`. CI gains the step. Then:

```bash
npm run check:secrets                              # expect: clean
orchestration/notify.sh review "guard installed"   # expect: message on the phone
grep -rn "1234567890" --exclude-dir=.git . || echo "token absent from repo: correct"
```

- [ ] **Step 5: Commit**

---

## Task 2: The board and the selection policy

The brain. Pure functions, no I/O, fully unit tested — this is where a silent bug burns
unattended compute.

**Files:** create `orchestration/policy.mjs`, `orchestration/policy.test.ts`,
`orchestration/board.mjs`

**Produces:**
- `selectWork({ board, control, now, maxConcurrent, maxAssumptions, maxStackDepth })`
  → `{ dispatch: Task[], reason: string, idle: boolean }`
- `ingestAnswers(board, answers)` → `{ board, invalidated: Task[] }`
- `reconcile(board, prStates)` → `board`
- `loadBoard(dir)` / `saveBoard(dir, board)` — the only I/O, in `board.mjs`

- [ ] **Step 1: Write the failing tests for `selectWork`**

The L3 policy, in strict order, is the contract:

1. Global stop → `dispatch: []`, `idle: true`.
2. Tasks whose category is paused are never dispatched.
3. Tasks whose `dependsOn` are unmerged are dispatched **stacked** (baseBranch = parent branch)
   — not skipped — provided stack depth < `maxStackDepth`.
4. At stack depth limit, prefer an independent task.
5. Critical-path order (`build-plan.md`) wins ties.
6. **Only when no unblocked task exists**, fall back to the `lowValue: true` backlog.
7. **Only when that is also empty**, dispatch a blocked task with an assumption — and never
   more than `maxAssumptions` open at once.
8. Otherwise idle.
9. Never exceed `maxConcurrent` running.
10. A task at `attempts >= 3` is never dispatched; it is blocked pending a question.

Plus `ingestAnswers`: an answer that contradicts a running task's assumption marks it
`invalidated` so its branch is abandoned rather than silently kept.

- [ ] **Step 2: Run, confirm red. Step 3: Implement. Step 4: Confirm green.**

Vitest include already covers `scripts/**/*.test.ts`; add `orchestration/**/*.test.ts` to
`vitest.config.ts`.

- [ ] **Step 5: Commit**

---

## Task 3: The task catalogue

**Files:** create `orchestration/tasks.md`, `orchestration/tasks.json`

Reviewable by a human, not generated at runtime — a wrong decomposition otherwise produces
busywork nobody notices.

- [ ] **Step 1: Decompose build steps 2–10 into loop-sized tasks**

Each: `id`, `title`, `category`, `model` (per L2: `opus` for `src/broker/**`, else `sonnet`),
`stream`, `paths`, `dependsOn`, `lowValue`, and a **definition of done**.

Seed from `build-plan.md` §Sequence and `docs/development/testing.md`'s six security-critical
areas. Categories: `broker`, `shim`, `loader`, `torrent-app`, `browser-ui`, `trust`, `nostr`,
`telemetry`, `packaging`, `docs`, `tests`, `tooling`.

The low-value backlog (L3 fallback b) must be genuinely useful and genuinely non-blocking:
release-checklist items, the `orivon-electron` skill's gaps, ADR tidying, test coverage for
existing pure functions.

- [ ] **Step 2: Sanity-check paths against the ownership map**

No two concurrent-eligible tasks may declare overlapping `paths`. Assert it in a test.

- [ ] **Step 3: Commit**

---

## Task 4: The loop command

**Files:** create `.claude/commands/orivon-loop.md`

The instructions the headless run follows each cycle. Written as an operating procedure, not
prose: reconcile → ingest → select (call `policy.mjs`, do not re-derive the policy in prose) →
dispatch → land → record → notify.

- [ ] **Step 1: Write the command**

Must specify, concretely:
- Worktree per task: `git worktree add ../orivon-wt-<id> -b stream/<id>` from `baseBranch`.
- Agent dispatch with `model` per task and `isolation: "worktree"`.
- The agent's brief: task, owned paths, contracts it may use, definition of done, **and the
  instruction to queue a question rather than guess**.
- The gate before any PR: `typecheck`, `test`, `check:natives`, `check:contracts`,
  `check:secrets`, plus `smoke` if `src/main/` changed.
- PR body: the four-part format from `CONTRIBUTING.md`, plus `ASSUMED:` handling.
- **Never merge. Never edit `.claude/`, `orchestration/loop.sh`, or dotfiles.**
- Question format: plain language, options explained before the choice is asked for.

- [ ] **Step 2: Commit**

---

## Task 5: The cron entry point

**Files:** create `orchestration/loop.sh`, `orchestration/loop-settings.json`

- [ ] **Step 1: Write `loop.sh`**

Modelled on `scripts/devlog-cron.sh`, with the same allow-list discipline:

- Lockfile at `orchestration/state/run.lock` holding PID + start time; stale after 90 min;
  refuse to start if a live PID holds it.
- Exit early on `control.json.globalStop`.
- `claude -p "/orivon-loop"` with `--settings orchestration/loop-settings.json`,
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, and a scoped `--allowedTools`.
- Log to `orchestration/state/runs/<iso>.log`; keep the last 200.
- On non-zero exit, notify `failure` — **but not every cycle.** A usage-limit exit is the
  expected steady state when the plan is exhausted, so suppress repeats of an identical failure
  within 6 hours.

- [ ] **Step 2: Write `loop-settings.json`**

Deny list as defence in depth, remembering: `Write(path)` deny rules are **silently ignored**;
only `Edit(path)` applies. Deny `Edit(./.claude/**)`, `Edit(./orchestration/loop*.…)`,
`Edit(~/.ssh/**)`, `Edit(~/.claude/**)`, `Edit(~/.bashrc)`, and the rest of the devlog set.

- [ ] **Step 3: Verify the guardrails actually hold**

Do not assume. Run a probe cycle that attempts each forbidden write and confirm refusal:

```bash
orchestration/loop.sh --probe    # attempts: ~/.bashrc, .claude/settings.json, loop.sh itself
```
Expected: all three refused, exit 0, probe result printed. **If any succeeds, stop.**

- [ ] **Step 4: Commit**

---

## Task 6: The dashboard

**Files:** create `orchestration/dashboard/server.mjs`, `orchestration/dashboard/index.html`;
modify `package.json`

- [ ] **Step 1: Write the server**

`node:http`, no dependencies, bound to `127.0.0.1` only — never `0.0.0.0`. Routes:

| | |
|---|---|
| `GET /` | the page |
| `GET /api/state` | board + open questions + control + last cycle time |
| `POST /api/answer` | append to `answers.jsonl` |
| `POST /api/control` | pause/resume a category, global stop/resume |
| `POST /api/kill` | mark a running task for termination |

Reject any request whose `Origin` header is present and not localhost (DNS-rebinding defence —
the same threat class as T12, and a local server with write endpoints is exactly what it
targets).

- [ ] **Step 2: Write the page**

One HTML file, inline CSS and JS, polling `/api/state` every 3 s. Order top to bottom, by what
most needs the owner's attention:

1. **PRs awaiting review** — with links. This is the L1 bottleneck, so it is first.
2. **Questions awaiting an answer** — options, AI recommendation, a reply box.
3. **Running on an assumption** — flagged.
4. Running now; blocked; recent cycles; log tail.
5. Category pause toggles, and global stop.

- [ ] **Step 3: `npm run panel`, and verify end to end**

```bash
npm run panel &
curl -s localhost:7717/api/state | head
curl -s -X POST localhost:7717/api/control -d '{"pause":"browser-ui"}'   # expect: reflected in state
curl -s -H 'Origin: http://evil.example' -X POST localhost:7717/api/control -d '{}'  # expect: refused
```

- [ ] **Step 4: Commit**

---

## Task 7: Install, dry-run, then arm

- [ ] **Step 1: Dry run, dispatching nothing**

```bash
orchestration/loop.sh --dry-run
```
Expected: a cycle log showing which tasks *would* dispatch and why, no worktrees, no branches,
no PRs. **Read the reason string** — if the selection order does not match L3, fix the policy
before arming anything.

- [ ] **Step 2: One live cycle, concurrency 1, on a low-value task**

Confirm end to end: worktree created, agent ran, gate passed, branch pushed, PR opened against
`main`, PR **not** merged, board updated, Telegram message received.

Then confirm cleanup: `git worktree list` shows no orphans.

- [ ] **Step 3: Install the crontab entry**

```bash
(crontab -l 2>/dev/null; echo "*/23 * * * * /home/jhon/Desktop/Develop/Claude/orivon-mvp/orchestration/loop.sh") | crontab -
```

23 minutes, not 20 — an off-interval avoids landing with every other scheduled job on the hour.

- [ ] **Step 4: Watch two cycles, then hand over**

Confirm the lockfile prevents overlap, the board advances, and the dashboard reflects it.

- [ ] **Step 5: Document and commit**

`orchestration/README.md`: what this is, how to stop it, how to answer a question, how to pause
a category, where the logs are, and **how to turn it off entirely** — that last one first,
because it is what someone reaches for in a hurry.

---

## Verification that this works at all

Not "it ran" — these are the falsifiable claims:

1. A cycle killed mid-run (`kill -9`) leaves the board consistent, and the next cycle resumes
   without duplicating work.
2. Two overlapping cron fires produce exactly one run.
3. A paused category dispatches nothing; the others keep moving.
4. Global stop halts dispatch within one cycle.
5. The loop cannot write `~/.bashrc`, `.claude/settings.json`, or `orchestration/loop.sh`.
6. No PR is ever merged by the loop.
7. An answer contradicting a running assumption invalidates that branch.
8. `npm run check:secrets` fails on a planted token and passes on the real tree.
