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

**[`transport.ts`](transport.ts)'s "batching" is one aggregate payload per period, never per
event.** ADR-0004 already settles the wire shape at one object per period
(installId/country/version/period/perApp), so there is no per-event payload to batch in the
first place — enforced by the input type itself: `attemptSend` only ever sees a
`TelemetryPayload` built once from `disclosure.ts`'s `buildDisclosurePayload`, never a raw
`TelemetryEvent`, so no code path here could fire one request per accounting event even by
accident. What the module adds on top is a small outbox — `enqueue` stages a period's payload,
`attemptSend` sends at most one queued payload per call, gated by consent and backoff.

**Why `MAX_QUEUE_SIZE` is 1, an owner decision, not an AI judgment call.** ADR-0004 says "send
once per period at a randomised offset; do not queue-and-retry into a backlog that reconstructs
the timeline just removed." Holding at most the single most-recent period's payload cannot be
called a backlog under any reading of that sentence. Cost: a device offline across a month
boundary loses the older of the two periods once it reconnects, rather than sending both. A
caller may still override the cap; see `enqueue`.
