# Unattended run protocol

**Two owner rules, taken 2026-09-09, and stated as absolutes.** They govern any long unattended
run in this repository -- the fleet runs out of `/home/jhon/.claude/orivon-fleet/`, and any loop
or scheduled agent.

1. **A question never halts the run.** An agent that needs an owner decision parks the question
   and immediately moves to work that does not depend on the answer.
2. **A usage limit pauses the run, it never ends it.** Hitting a limit schedules its own
   resumption. The owner should never have to restart anything by hand.

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

### What is honestly measurable, and what is not

**There is no tool that reports "you are at 90% of the account limit".** An agent cannot poll a
fuel gauge. Pretending otherwise would produce a rule that silently never fires, which is worse
than no rule. So the outcome the owner asked for is delivered two ways instead, and both are real:

**Throttle the burn rate rather than measure the remainder.** Concurrency is what sets the rate.

- At most **three lanes dispatched at once** by default. The heaviest items -- `net.listen`, the
  full test suite, any real Electron launch -- run serialised, never two at once.
- One real Electron e2e at a time, always. Two suites contending for fixture ports and the same
  binary is already a known failure here, independent of any limit.

**Recover automatically when a limit does arrive.**

1. Write the resume point: current lane state, the exact next step, and any half-finished work
   committed to its branch (never left only in a working tree).
2. Schedule the resumption. Wakeups are capped at an hour each, and the rolling window is longer
   than that, so **chain them**: wake, check whether work is possible, and if not, schedule
   another. A run must never end because a single timer was too short.
3. Resume by reading `RESUME.md` and continuing. No owner action.

### The owner's override, when they can see the gauge

The owner *can* see real usage (`/usage`). Two directives are honoured at the next checkpoint:

- `/orivon-tell conductor pace: slow` -- drop to one lane at a time.
- `/orivon-tell conductor budget: <number>` -- a real ceiling. At **90% of that number** the
  conductor stops dispatching new work, finishes what is in flight, writes the resume point and
  schedules resumption. This is the literal 90% rule, and it works the moment there is a number
  to measure against.

Absent a number, `pace: normal` with three lanes is the default, chosen so a limit is survivable
rather than avoided by guesswork.

---

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
