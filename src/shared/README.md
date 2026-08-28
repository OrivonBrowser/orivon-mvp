# `src/shared/` — helpers needed on both sides of a trust boundary

**Empty by design as of 2026-08-27.** It exists so that Rule 3 of
[`code-guidelines.md`](../../docs/development/code-guidelines.md) has a legal answer, not
because anything has moved here yet.

**What lives here.** Pure, dependency-free helpers that **more than one stream genuinely needs**
and that no single stream can own — byte and string utilities, encoding primitives, small
data-structure helpers.

**What it depends on.** Nothing.

**What it must never import.** **Anything.** Not `electron`, not `node:*`, not a package, not
[`src/contracts/`](../contracts/), not another `src/` directory. A helper that needs any of
those belongs to a stream, not here.

**Owner stream.** None — it is **change-controlled**, the way [`src/contracts/`](../contracts/)
is. A change here goes in its **own PR and merges first**, never mixed with an implementation
([`CLAUDE.md`](../../CLAUDE.md) §Parallel work). One edit here can touch every stream at once,
which is the whole reason for the ceremony.

---

## Why it exists

[`src/broker/`](../broker/) must never import [`src/shim/`](../shim/), and `src/shim/` must
never import `src/broker/` — importing the broker would hand renderer-side code main-process
authority. Those boundaries are load-bearing and are not going to be relaxed.

The consequence is that a helper both sides need had **nowhere legal to live**, so whichever
stream wrote it second was forced to write a second copy. That is the one case where Rule 3
("one implementation per idea") could not be followed. This directory is the answer to it.

`src/contracts/` cannot serve the purpose: `npm run check:contracts` deliberately fails the
build if anything there references code outside itself, and runtime helpers are not contracts.

## The bar for putting something here

**Two callers on opposite sides of a boundary.** Not one. Not two callers in the same stream —
those belong in that stream, next to their use.

Moving a helper here is not free: it becomes change-controlled, it gains a second stream that
can break, and it is harder to delete. Weigh that against the duplication it removes.
[`CLAUDE.md`](../../CLAUDE.md) Rule 7 still applies — no abstractions for elegance alone.

**Same shape is not the same reason.** Two functions that look alike but answer to different
requirements are not duplicates, and merging them here creates a coupling that has to be undone
later. Extract when the *reason* is shared.

## Known candidates

**None currently.** The `concat`/`encodeField` pair that motivated this directory's own worked
example turned out not to need it: both copies were inside `src/broker/policy/` — same
directory, same stream — and were consolidated there instead, into
[`policy/bytes.ts`](../broker/policy/bytes.ts) (2026-08-27, `stream/backlog-07-guidelines-
cleanup`). A wider Rule-3 audit the same week found six more duplicates across the broker; every
one of them was fixable inside its own directory. Confirmed, not assumed: nothing in the current
tree crosses the `src/broker/` <-> `src/shim/` boundary this directory exists to serve. See
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 3 for the full audit.
