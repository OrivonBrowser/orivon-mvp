# `src/trust/` — the trust indicator

**What lives here.** The delivery ladder, the connection ladder built from the broker's
per-app connection log, and operation scoring. Click-through shows **the actual evidence, not
a grade** ([`ADR-0006`](../../docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)).

**What it depends on.** [`src/contracts/`](../contracts/), and the broker's connection log
*through a contract* — never by reaching into broker internals.

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `trust` — build step 6. First to be cut if the shell or broker overruns.

**What this component exists to prevent.** Overclaiming. It must never present something as
safer than it is — the honesty note about MSE being *obfuscation, not privacy* is the worked
example.
