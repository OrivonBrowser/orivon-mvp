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

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**One entry shape for all three capability surfaces**
([`connection-log.ts`](connection-log.ts)). A network connect, an `orivon.fs` operation and an
`orivon.id` operation differ in almost every respect, but they are alike in the one respect
this component cares about: each is a broker decision the app cannot see around. Three separate
entry types would force every consumer — the connection ladder, operation scoring — to merge
three arrays back together to answer "what did this app do, in order". One shape with a
`surface` discriminant avoids that.

**Byte counts and duration are part of that shape, not an optimisation.**
[`ADR-0006`](../../docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)'s
2026-08-25 amendment found the connection ladder was cheaper to fake than to earn: an app
exfiltrating a user's files by opening many short connections to many distinct hosts would
classify at the best available grade, *earned by the attack itself*. The accepted fix was byte
accounting per endpoint plus a byte-asymmetry signal — real swarm traffic is roughly symmetric,
exfiltration is not.

**Omitted connect patterns are carried alongside entries, not folded into them.** An omission is
not something that *happened*; it is a standing fact about the grant ("this pattern can never
appear in `entries`, even if the app tries it"), true for the whole observation window rather
than at one timestamp ([`open-questions.md`](../../docs/open-questions.md) A43).

**`OmittedConnectReason` is deliberately smaller than the broker's own vocabulary.**
[`connect-src.ts`](../broker/policy/connect-src.ts)'s `ConnectSrcOmissionReason` distinguishes
reasons an app *author* needs — a malformed pattern is their bug to fix. A trust screen showing
a *user* what broke has no use for that distinction, so whoever wires the real derivation to
this module maps those reasons down to these.
