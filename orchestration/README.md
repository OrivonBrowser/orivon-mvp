# The autonomous build loop

A cron job that runs Claude Code every 23 minutes to work through
[`tasks.json`](tasks.json), opening a pull request per task. **It never merges** — every change
waits for the owner.

---

## How to stop it

First, because it is what you reach for in a hurry.

```bash
orchestration/loop.sh --stop      # stops at the next cycle; running work finishes
orchestration/loop.sh --resume
```

Or press **Stop the loop** on the panel. To stop it permanently:

```bash
crontab -e     # delete the orchestration/loop.sh line
```

To pause only one kind of work — say you want to redesign the browser UI yourself — use the
**category buttons** on the panel. That category stops; everything else keeps moving.

---

## The panel

```bash
npm run panel     # http://127.0.0.1:7717
```

Shows, in order of how much it needs you:

1. **Pull requests waiting for review.** Nothing merges without you, so this queue is the
   bottleneck by design. Clearing it roughly daily is what keeps the loop useful.
2. **Questions waiting for an answer**, with options and a suggestion. Type a reply in plain
   words; the next cycle picks it up.
3. **Anything running on an assumption** — work built on a guess, which your answer either
   confirms or discards.
4. Running now, blocked, category pauses, and the stop button.

Bound to `127.0.0.1` only, and it refuses cross-origin requests: it can stop your build and
inject answers, so a random browser tab must not be able to reach it.

---

## What it does each cycle

```
reconcile PRs -> apply your answers -> select work -> dispatch agents
   -> run the gate -> open PRs -> update the board -> notify if needed
```

**Selection order** ([`policy.mjs`](policy.mjs), 33 tests, owner decision L3):

1. Unblocked work, in catalogue order — which is the critical path.
2. **Only if none:** the low-value backlog.
3. **Only if none:** a blocked task, on a **labelled assumption**, capped at two at a time.
4. **Only if none:** idle.

Guessing is the last resort, never the second.

**Models** (owner decision L2): Opus writes `src/broker/**` — the code deciding whether an app
may open a socket or read a file. Sonnet writes everything else.

**Stacking:** since nothing merges without you, a task depending on an unreviewed PR branches
*from that PR* rather than waiting. GitHub retargets it to `main` when the parent merges. Capped
at 4 deep, because a rejection near the base throws away everything above it.

---

## Auto-resume

**The loop holds nothing in memory.** All state is in `state/`, so a cycle killed by a usage
limit, a reboot, or `kill -9` costs at most that one cycle — the next run reads the board and
carries on. There is nothing to restore.

When the plan is exhausted, cycles fail fast and cheaply until it resets, then work resumes on
its own. Repeated identical failures are suppressed for six hours so you are not messaged every
23 minutes overnight.

---

## Safety

| Control | What it stops |
|---|---|
| Agents work in a **git worktree** | Writes confined to a directory outside this checkout |
| `--allowedTools` **allow-list** | A deny-list cannot contain a tool granted for every path — the devlog cron learned this when a test write to `$HOME` succeeded |
| [`loop-settings.json`](loop-settings.json) | **The loop may not edit its own guardrails.** One that can widen its own permissions has none |
| `--strict-mcp-config` | No MCP servers unattended. Exfiltration is worse than a bad file write |
| No merge, ever | Enforced by the loop *and* independently by branch protection |
| `check:secrets` + pre-commit hook | No credential reaches this public repo |

**Verify the guardrails before arming, and after any change to the settings:**

```bash
orchestration/loop.sh --probe
```

It checks **both directions** — that forbidden writes are refused *and* that permitted ones
still work. A permission set that refuses everything passes a refusal-only probe and then
silently does nothing, which looks exactly like "the loop stopped".

> **Scheduled review:** inputs are first-party today. When outside contributions land, PR titles
> and commit messages become attacker-controlled text flowing into an unattended agent. Revisit
> the allow-list then — `build-plan.md` actively wants outside contributors, so this will happen.

---

## Files

| | |
|---|---|
| [`tasks.json`](tasks.json) / [`tasks.md`](tasks.md) | The work, hand-authored. Order is priority |
| [`policy.mjs`](policy.mjs) | Selection, purely functional and exhaustively tested |
| [`board.mjs`](board.mjs) | The only module that touches disk. Atomic writes, the run lock |
| [`loop.sh`](loop.sh) | Cron entry, the off switch, the probe |
| `.claude/commands/orivon-loop.md` | What a cycle actually does |
| [`dashboard/`](dashboard/) | The panel |
| `state/` | Board, questions, answers, logs. **Gitignored** — machine-owned and churning |

Design and the six decisions behind it:
[`docs/planning/autonomous-loop-design.md`](../docs/planning/autonomous-loop-design.md).

---

## Troubleshooting

**Nothing is happening.** Check the panel's heartbeat. No beat for 50 minutes against a
23-minute cron means it is not running: `crontab -l`, then the newest file in `state/runs/`.

**It keeps failing.** `tail state/runs/$(ls -t state/runs | head -1)`. A usage-limit exit is
normal and self-healing.

**A task failed three times.** The policy stops selecting it and queues a question instead of
retrying forever. Answer it on the panel.

**A PR is stacked on another and I want to reject the base.** Close both. The loop rebuilds the
child from `main` on a later cycle.
