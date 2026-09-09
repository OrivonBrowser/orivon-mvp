# Unattended run protocol

**Two owner rules, taken 2026-09-09, and stated as absolutes.** They govern any long unattended
run in this repository -- the fleet runs out of `/home/jhon/.claude/orivon-fleet/`, and any loop
or scheduled agent.

1. **A question never halts the run.** An agent that needs an owner decision parks the question
   and immediately moves to work that does not depend on the answer.
2. **A usage limit pauses the run, it never ends it.** The 5-hour session window is read live at
   every checkpoint; at 90% the run stops dispatching, writes its resume point and schedules its
   own resumption. The owner should never have to restart anything by hand.

The failure both rules exist to prevent is the same one: **the owner goes to sleep and the run
spends ten hours idle**, either waiting on an answer or dead from a limit it never recovered from.

---

## Rule 1 -- questions do not block

### The mechanism

Every lane writes checkpoints to `$F/lanes/<id>/log.md` with a kind. `QUESTION` is one of them,
and this protocol defines what it means:

    ## QUESTION -- <one line>
    BLOCKS: <the queue items that genuinely cannot proceed>
    DOES NOT BLOCK: <what this lane is picking up instead, right now>
    NEXT: <the item the lane moved to>

**A `QUESTION` checkpoint without a `NEXT` line naming different work is a protocol violation**,
not a status. If a lane truly has nothing left that is unblocked, it writes `DONE` with the
remaining items listed as parked, and the conductor gives it a different lane's work.

### Batching, so the owner is not drip-fed

Parked questions accumulate in the register. When the owner returns, they are asked **in one
batch**, ordered by how much work each unblocks. Six questions asked together cost one
conversation; six questions asked one at a time across a night cost the night.

### Answering, without interrupting anything

The owner answers through `/orivon-tell`, which appends to `INBOX.md` and is picked up at the next
checkpoint. No session needs to be interrupted, and an answer given at 03:00 is acted on at 03:05
without the owner being present.

### What this looks like against the current queue

The point of the table is that **there is always unblocked work**. Taken from
[`../planning/unattended-build-queue.md`](../planning/unattended-build-queue.md):

| If this is parked | Genuinely blocked | Still fully workable |
|---|---|---|
| The two ADRs (synchronous reads; Orivon owning the app's HTTP path) | Merging the Phase 1 contracts PR, and 2.2, 2.3, 3.3, 3.4 which depend on it | 0.3, 0.4, 0.5, 2.1, 2.4, 2.5, 3.1, 3.2, 3.5 -- **nine items, including the largest one in the queue** |
| Any Phase 4 wording or design question | Only that item's final surface | 4.1's plumbing, every other Phase 4 item, and all of Phase 5's Node lane |
| A dependency needing owner approval (Rule 6/8) | Only the item that wanted it | Everything else; the item is parked with the alternative packages listed |
| A security tradeoff | Only that item | Everything else, and the tradeoff is written up while the memory of it is fresh |

**The one thing that is not a park.** An item that would touch an excluded row -- ambient
filesystem, `subprocess`, `hid`/USB -- is **dropped, not parked**. Those are refusals, and asking
again is not progress.

---

## Rule 2 -- a limit pauses, it never ends

### It is measurable, and this is the exact gate

**Scope: the 5-hour session window only.** Owner's decision, 2026-09-09. The 7-day window is
recorded for visibility and is **never** a gate.

The `claude-status-mcp` package reports live usage, and it has a **command-line mode** -- so this
works from any unattended session with no MCP connection required:

    npx -y claude-status-mcp | jq -r '.usage.five_hour | "\(.utilization) \(.resets_at)"'
    # -> 10 2026-09-09T21:29:59+00:00

`--pretty` renders the same thing with progress bars, which is the right form for a ledger line.
The fields that matter: `.usage.five_hour.utilization` (whole-number percent) and
`.usage.five_hour.resets_at` (ISO timestamp). `.usage.limits[]` carries the same figure with
`kind: "session"` and a `severity`.

**The gate, checked before dispatching any lane and at every checkpoint** (it costs about a
second):

| `five_hour.utilization` | Action |
|---|---|
| under 75 | Dispatch normally |
| 75 to 89 | Finish in-flight work; start **no new heavy item** -- no full suite, no Electron launch, no new lane |
| **90 or above** | **Stop dispatching.** Let in-flight work reach its next checkpoint, commit it to its branch, write the resume point, schedule resumption for `resets_at` plus two minutes, and log the pause with the number that caused it |

### Why throttling stays, even with a real gauge

**Utilization is a level, not a rate.** Reading 60% says nothing about whether the next dispatch
lands at 65% or 95%. The gauge tells the run where it is; the concurrency cap is what stops it
crossing the line between two readings. Both, not either:

- At most **three lanes dispatched at once** by default.
- The heaviest items -- `net.listen`, the full test suite, any real Electron launch -- serialised,
  never two at once. One real Electron e2e at a time, always: two suites contending for fixture
  ports and the same binary is a known failure here, independent of any limit.

### Resuming, and the one honest limitation

The reset timestamp is known exactly, so resumption is scheduled *at* it rather than guessed. But
**an in-session timer dies with the session**, so a timer alone is not a recovery plan. The durable
path is the one the fleet already has:

1. Write the resume point into the state store -- current lane state, the exact next step, and any
   half-finished work committed to its branch. **Never left only in a working tree.**
2. Record the pause and the reset time in `ledger.md`, so a fresh session sees why nothing moved.
3. Schedule the resumption. Wakeups cap at an hour, so where the reset is further out, **chain
   them** -- wake, re-read the gauge, and either resume or schedule again.
4. If the session itself is gone, `/orivon-continue` reads `RESUME.md` and picks up from step 1's
   record. That is what makes the recovery survive a killed process rather than only a pause.

### The owner's overrides

- `/orivon-tell conductor pace: slow` -- one lane at a time.
- `/orivon-tell conductor budget: <percent>` -- gate at a different number than 90.

## Checkpoint discipline, because the dashboard depends on it

Every lane writes a checkpoint at least every ~30 minutes of work, with `NEXT:` on every one.
`/orivon-fleet` marks a lane **stalled?** when its last checkpoint is over 45 minutes old and not
terminal -- and from outside, **a killed agent and a thinking agent look identical.** Only the
clock separates them, so a silent lane is indistinguishable from a dead one and gets treated as
dead.

Kinds: `PROGRESS`, `QUESTION` (see Rule 1's required shape), `BLOCKED` (an external gate, not an
owner decision -- CI, a merge conflict, a missing worktree), `DONE`.

## What still legitimately ends a run

Only these, and none of them is a question or a limit:

- The owner says stop, through `INBOX.md`.
- Every queue item is either done, parked with its question registered, or dropped as excluded.
- A repository-level gate no agent may pass alone: an ADR needing owner attribution, with no
  unblocked work left anywhere. **Record this as the reason in `RESUME.md`** -- a run that ends
  without saying why reads as a crash.
