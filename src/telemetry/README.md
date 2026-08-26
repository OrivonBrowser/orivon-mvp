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
