# `src/telemetry/` — measurement and its disclosure

**What lives here.** Event collection, session accounting, the first-run disclosure screen, and
the in-product "what has been sent" page.

**What it depends on.** [`src/contracts/`](../contracts/).

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `telemetry` — build step 8. Independent of the critical path, so it is one of
the streams that can run concurrently today.

**The disclosure UI is not optional** ([`ADR-0004`](../../docs/decisions/ADR-0004-telemetry.md)):
the literal JSON that would be sent, two buttons of equal visual weight, **no preselected
default**, and **nothing transmitted before the choice is made**.

**`activeSec` and `backgroundSec` are separate numbers, and the metric is stated on
`activeSec`.** A torrent client seeds in the background — that is what it is for — so measuring
"app open" would let a user who pasted one magnet and walked away accumulate 24 h/day. That
made the daily-use hypothesis unfalsifiable in the direction that flatters it.

**This is the number the project is judged on, and its likeliest bug biases it downward** —
making a succeeding product look like a failing one. Hence the pure-fold unit test over an
event stream, including month rollover and abnormal termination.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**`accounting.ts`'s `applyEvent` is an incremental reducer, meant to run one event at a time in
the real collector** ([`runner.ts`](runner.ts)), with the caller persisting `AccountingState` —
I/O, deliberately kept outside `accounting.ts` itself — periodically, so a crash loses at most
the time since the last processed event. The `'checkpoint'` event kind exists purely to give the
caller a place to inject that persistence during an otherwise-silent stretch, such as a torrent
seeding for hours with no focus change.

**`store.ts` diverges from [`src/main/bookmarks.ts`](../main/bookmarks.ts) on debouncing, on
purpose.** `BookmarkStore` debounces every write because a user can star/unstar rapidly and each
click is independently worth persisting soon. Accounting state changes continuously as time
passes, not in discrete user actions — debouncing it would just mean "write shortly after every
processed event", exactly the write-on-every-tick I/O pattern the checkpoint design above exists
to avoid. So accounting/history writes are explicit (`checkpoint()`), while country/consent —
genuine discrete user decisions that must not be lost to a crash right after the click — persist
immediately, the same as `BookmarkStore`'s `add()`/`remove()`.
