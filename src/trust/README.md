# `src/trust/`: the trust indicator

**What lives here.** The Website level this browser can observe (Level 1 or 2 of the Web3 Score
scale in the root `README.md`; `website-level.ts`), the Delivery level on the Connection-to-network scale
(`delivery-ladder.ts`), the connection ladder built from the broker's per-app connection log (a
different axis, still unwired: nothing observes per-app connections yet), operation scoring, and
the same-host hash tree check (`ddoc.ts`), whether a judged level counts at the address it is shown at
(`domain-binding.ts`, `ADR-0056`), whether an update offered to an installed app at a name is verified
(`app-update-trust.ts`), and what a Web3 Score provider answers, read as
[`web3-score-provider.md`](../../docs/architecture/web3-score-provider.md) defines it
(`score-provider.ts`; fetched by `../main/browsing/score-provider-client.ts`). Click-through shows the level and, beneath it, **the
actual evidence it rests on**
([`ADR-0006`](../../docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)). A
developer-only override (`../main/dev/score-levels.ts`) can preview levels no automatic path
reaches, always named as an override, never as observed or judged.

**What it depends on.** [`src/contracts/`](../contracts/), and the broker's connection log
*through a contract*, never by reaching into broker internals.

**What it must never import.** [`src/broker/`](../broker/) internals.

**Tied to Electron?** No: pure functions, no I/O.

**Owner stream.** `trust`, build step 7. First to be cut if the shell or broker overruns.

**What this component exists to prevent.** Overclaiming. It must never present something as
safer than it is; the honesty note about MSE being *obfuscation, not privacy* is the worked
example.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

The DDOC verdict, the Website level and the Delivery level are explained in their own files
(`ddoc.ts`, `website-level.ts`, `delivery-ladder.ts`) and in
[`ADR-0029`](../../docs/decisions/ADR-0029-sites-publish-their-bundle-hash-tree.md) §Reasoning.

**One entry shape for all three capability surfaces**
([`connection-log.ts`](connection-log.ts)). A network connect, an `orivon.fs` operation and an
`orivon.id` operation are alike in the one respect this component cares about: each is a broker
decision the app cannot see around. One shape with a `surface` discriminant spares every
consumer merging three arrays back together to answer "what did this app do, in order".

**Byte counts are part of that shape, and the connection ladder never exports a bare pattern
label.** Without bytes the ladder was cheaper to fake than to earn: exfiltrating files over many
short connections to many hosts earned the best grade (ADR-0006's amendment to §The insight this
rests on, finding 2). Real swarm traffic is roughly symmetric and exfiltration is not, so
[`connection-ladder.ts`](connection-ladder.ts) always returns `evidence` (the raw counts) and
`patternHeuristic` (the label) together, on every path. There must never be a function that
returns the label alone.

**Omitted connect patterns are carried alongside entries, not folded into them.** An omission is
a standing fact about the grant for the whole observation window, not an event at a timestamp
([`open-questions.md`](../../docs/open-questions.md) A43).

**`allAllowedWereGranted` checks granted patterns, not declared ones**, following A18's precedent
in [`connect-src.ts`](../broker/policy/connect-src.ts): the manifest may claim far more than was
approved. This module never sees a `Manifest`, so there is no declared set to compare against by
mistake.

**`OmittedConnectReason` is deliberately smaller than the broker's `ConnectSrcOmissionReason`.**
A malformed pattern is the app author's bug to fix; a user has no use for that distinction, so
whoever wires the real derivation maps the broker's reasons down to these.

**Pin coverage is counted in bytes, not requests. Provisional, and deliberately easy to
change.** One enormous remote script and forty tiny pinned icons read 40:1 pinned by request
count while the app's weight runs almost entirely unpinned; bytes read that correctly.
`PinCoverageEvidence` keeps both counts, so build step 7 can weigh by either. How sizes are read,
and why a missing one is a floor rather than a zero:
[`pin-coverage.ts`](../loader/serve/pin-coverage.ts)'s header.

**`PinCoverageEvidence` is defined once in each direction, not imported across.**
`delivery-ladder.ts`'s copy and `src/loader/serve/pin-coverage.ts`'s `PinCoverageSnapshot` are
structurally identical on purpose: this directory never reaches into another stream's
internals, and `src/loader/README.md` does not list this directory as something it may import
either. `scripts/tests/pin-coverage-parity.test.ts` keeps the two copies in step (A179).
