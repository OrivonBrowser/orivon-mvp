# Autonomous build loop — design

**Status: awaiting owner approval before implementation.**

**Goal (owner, 2026-08-26):** a system that lets Claude Code iterate continuously toward the
MVP goals, in parallel, surviving usage-limit exhaustion and session death — asking the owner
the same questions it would otherwise ask, but **queueing them instead of stopping**, and only
escalating when a question has become the actual bottleneck.

---

## Decisions taken

| # | Decision | Made by |
|---|---|---|
| L1 | **Nothing merges to `main` without the owner.** Every task becomes a PR; the loop never merges | Owner |
| L2 | **Opus writes `src/broker/` and `src/broker/policy/`; Sonnet writes everything else** | Owner |
| L3 | **When blocked: prefer unblocked lower-value work. Only proceed on an assumption when there is none left**, and flag it loudly | Owner |
| L4 | **Surfaces: a local dashboard (primary) plus push to phone.** No desktop-only notification | Owner |
| L5 | The scheduler is the **system crontab**, not `CronCreate` (session-only, 7-day expiry) | AI |
| L6 | Orchestration lives **in this repository** under `orchestration/`, with volatile state gitignored | AI |

**On L6.** The scripts are reviewable, versioned, and travel with the project — and a repository
substantially built by an autonomous loop should say so rather than hide the machinery
elsewhere. `scripts/devlog-cron.sh` already sets this precedent. Only the churning state
(`orchestration/state/`) is gitignored.

**On L1, honestly.** This is the option most likely to create a bottleneck, and the owner chose
it deliberately. The design compensates with **stacked branches**: work that depends on an
unapproved PR branches from it rather than waiting. GitHub retargets child PRs automatically
when the parent merges. The residual cost is real and is stated in §Risks.

---

## Shape

```
  crontab  --every 20 min-->  orchestration/loop.sh
                                   |
                                   |  lockfile, global-stop check, then:
                                   v
                            claude -p "/orivon-loop"        [Opus, headless]
                                   |
                    +--------------+--------------+
                    |              |              |
              reconcile        select work     dispatch
              (PRs, answers)   (L3 policy)         |
                                                   v
                                    Agent(model per L2) in a git worktree
                                                   |
                                        branch -> commit -> push -> PR
                                                   |
                                                   v
                                  orchestration/state/board.json
                                                   ^
                                                   |
                              dashboard (127.0.0.1) <-- owner answers,
                                                        pauses, stops
```

The loop is **stateless between runs.** Everything it needs is on disk, so a run killed by a
usage limit, a reboot, or a crash costs at most one cycle. That is the whole auto-resume
mechanism — there is nothing to restore because nothing is held in memory.

---

## State

`orchestration/state/` — gitignored, created on first run.

| File | Contents |
|---|---|
| `board.json` | Every task: status, category, model, branch, base branch, PR number, dependencies, blocking questions |
| `questions.jsonl` | Append-only. Each question the loop would have asked interactively |
| `answers.jsonl` | Append-only. Written by the dashboard; consumed by the loop |
| `control.json` | Per-category pause switches, plus a global stop |
| `run.lock` | PID + timestamp. Prevents overlapping cron runs |
| `runs/<iso>.log` | One log per cycle |

### A task

```jsonc
{
  "id": "broker-03-connect-check",
  "title": "checkConnect against resolved addresses, with the private-address table",
  "category": "broker",              // the pause-switch key
  "model": "opus",                   // per L2
  "stream": "broker",                // ownership map in parallel-work.md
  "paths": ["src/broker/policy/**"], // what it may write
  "dependsOn": ["contracts"],
  "status": "todo",                  // todo | running | pr-open | merged | blocked | conflict | abandoned
  "branch": null,
  "baseBranch": "main",              // or a parent task's branch, when stacked
  "pr": null,
  "blockedOn": [],                   // question ids
  "assumption": null,                // set when L3 fallback fires
  "attempts": 0
}
```

### A question

```jsonc
{
  "id": "q-0007",
  "asked": "2026-08-26T14:02:11Z",
  "task": "broker-03-connect-check",
  "urgency": "blocking",             // blocking | soon | whenever
  "question": "Plain-language question, with what each option means",
  "options": ["...", "..."],
  "aiRecommendation": "...",
  "whyItMatters": "what changes depending on the answer",
  "status": "open"                   // open | answered | superseded
}
```

Questions are written in the same register as an interactive question: **explain what each
option is before asking the owner to choose between them** — never bare identifiers.

---

## The cycle

Each run, in order:

**1. Guard.** Take the lockfile (stale after 90 minutes). If `control.json.globalStop`, exit.

**2. Reconcile.** For each `pr-open` task, ask GitHub whether it merged, closed, or went red.
Merged → `merged`, and rebase its stacked children. Closed → `abandoned`. CI red → back to
`todo` with `attempts++`, or `blocked` after 3 attempts with a question queued.

**3. Ingest answers.** Read `answers.jsonl`, mark questions answered, unblock their tasks, and
**re-examine any task that ran on an assumption the answer contradicts** — those branches get
abandoned and re-queued rather than silently kept.

**4. Select work** — the L3 policy, in strict order:

   a. **Unblocked tasks**, dependencies satisfied, category not paused. Critical path first
      (`build-plan.md` order), then everything else.
   b. **If none: unblocked lower-value work** — the backlog of tests, docs, tooling, release
      checklist items. This is L3's first fallback and it is preferred over guessing.
   c. **If still none: the highest-value blocked task, on an assumption.** Adopt the
      best-supported answer, set `assumption`, prefix the PR title `ASSUMED:`, and state the
      assumption as the first line of the PR body. Never more than **two** assumption-tasks
      open at once — beyond that the loop is building on sand and should idle instead.
   d. **If still none:** idle. Notify once, not every cycle.

**5. Dispatch.** Up to **3** concurrent tasks (tunable). Each gets its own git worktree at
`../orivon-wt-<task-id>` and its own branch, so two agents can never write the same file. Model
per L2. The agent is given: the task, its owned paths, the contracts it may depend on, the
definition of done, and the instruction to **queue a question rather than guess** when it hits
a real decision.

**6. Land.** Agent finishes → run the gate (`typecheck`, `test`, `check:natives`,
`check:contracts`, plus `smoke` if `src/main/` changed) → commit → push → open a PR against
`baseBranch` with the four-part body from `CONTRIBUTING.md`. Never merge.

**7. Record and notify.** Update `board.json`. Notify **only** on: a new blocking question, a
PR ready for review, a run failure, or the loop going idle. Never on routine progress.

---

## Parallelism, and the conflicts it will cause

Prevention is the ownership map in `docs/development/parallel-work.md`: disjoint paths per
stream, worktree per task, contracts changes in their own PR merged first.

**Stacking.** With L1, a task depending on unmerged work branches from that work's branch and
its PR targets that branch. GitHub shows only the incremental diff and retargets to `main`
automatically when the parent merges.

**Repair, in the owner's stated spirit — results first, conflicts are acceptable if cheap:**

- Every branch is rebased on its base immediately before the PR opens, so conflicts surface in
  the loop rather than in the owner's face.
- A conflict the agent cannot resolve marks the task `conflict` and moves on. It does not block
  the cycle.
- `package-lock.json` is never hand-merged — regenerate, per `CONTRIBUTING.md`.
- A task is retried at most 3 times before it becomes a question.

---

## The dashboard

`orchestration/dashboard/` — one Node HTTP server and one HTML page. **No dependencies**
(Rule 8), bound to `127.0.0.1` only.

Started with `npm run panel`, and by the cron job if it is not already up.

**Shows:**
- What is running right now, with elapsed time and which model
- **PRs awaiting your review**, with links — the L1 queue, and the thing most likely to be the
  bottleneck, so it is at the top
- **Questions awaiting an answer**, newest first, each with its options and the AI
  recommendation, and an input to reply
- Tasks blocked, and on what
- Any task currently running on an **assumption**, prominently — these are the ones to look at
  first
- The last few cycles' outcomes, and a tail of the current log

**Lets you:**
- Answer a queued question (writes `answers.jsonl`; the loop picks it up next cycle)
- **Pause or resume a category** — `browser-ui`, `broker`, `telemetry`, and so on. A paused
  category's tasks are not dispatched; anything already running finishes
- **Global stop** — the loop exits at the next cycle boundary and does not start again until
  resumed
- Kill a specific running task

**Why a category pause and not just a global stop:** the owner named "Browser UI" specifically
as the kind of work they may want to take over. Pausing one category lets the rest of the MVP
keep moving while they redesign it.

---

## Safety for unattended runs

`scripts/devlog-cron.sh` learned these the hard way; they carry over.

1. **Allow-list, never deny-list.** `--allowedTools` with scoped paths. A deny-list cannot
   contain a tool granted for every path.
2. **`Write(path)` deny rules are silently ignored** — only `Edit(path)` applies. Verified
   2026-08-25.
3. **Writes are confined to the worktree** for the dispatched agent, which is a stronger bound
   than any path pattern on the main checkout.
4. **The loop may not edit its own guardrails.** `orchestration/loop.sh`, `.claude/`,
   `orchestration/*-settings.json`, the crontab, and every dotfile under `~` are denied. A loop
   that can widen its own permissions has none.
5. **`--strict-mcp-config` with an empty config.** No MCP servers in an unattended run;
   exfiltration is a worse outcome than a bad file write.
6. **No merging, ever** (L1) — the loop holds no write access to `main`. Branch protection
   enforces this independently of the loop behaving.
7. **Today's inputs are first-party.** When outside contributions land, PR titles and commit
   messages become attacker-controlled text flowing into an unattended agent. **Revisit this
   section then** — it is a scheduled review, not a hypothetical.

---

## Risks

| Risk | Handling |
|---|---|
| **L1 makes the owner the bottleneck** | Stacked branches keep work flowing; the dashboard puts the review queue first. If it still stalls, L1 is one line of policy to relax |
| A stack of unapproved PRs, then a rejection near its base | Cap the stack depth at 4. Beyond that, the loop switches to independent work |
| An assumption turns out wrong | Bounded to 2 open at a time, `ASSUMED:` in the title, stated in the PR body, branch dropped on contradiction. Cost is tokens, not correctness |
| Sonnet writes something subtly wrong outside the broker | CI is the floor. `adversarial-reviewer` runs on the app loader and shim per the tooling table. The broker itself is Opus (L2) |
| Runaway token spend | Concurrency cap of 3, retry cap of 3, idle rather than churn, and a global stop that takes effect at the next cycle |
| Two cron runs overlap | Lockfile with PID and a 90-minute staleness timeout |
| The loop silently dies | Every cycle writes a log and a heartbeat; the dashboard shows the last cycle time and flags a stale one |
| A wrong task decomposition produces busywork | The catalogue is a reviewable file (`orchestration/tasks.md`), not generated at runtime |

---

## What this does not do

- **It does not merge.** Ever. (L1)
- **It does not decide anything the owner should decide.** It queues, and proceeds on an
  explicit, labelled assumption only when there is genuinely nothing else to do (L3).
- **It does not touch `src/contracts/` and an implementation in the same PR** — the
  contracts rule from `parallel-work.md` applies to agents exactly as to humans.
- **It does not replace the readability check.** That remains a human gate at the end of every
  build step, and the loop queues it as a question rather than skipping it.
