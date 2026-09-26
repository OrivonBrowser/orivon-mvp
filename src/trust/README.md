# `src/trust/`: the trust indicator

**What lives here.** The Website level this browser can observe (Level 1 or 2 of the canonical
[Web3 scores](https://docs.orivonstack.com/docs/implementations/web3-score) page; `website-level.ts`),
the Delivery level on that same page's Connection-to-network scale (three levels, red/yellow/
green; `delivery-ladder.ts`), the connection ladder built from the broker's per-app connection log
(a different, still-unwired axis -- see Design notes below), operation scoring, and the same-host
hash tree check: whether the pinned bundle matches the tree its site publishes. Click-through
shows the level and, beneath it, **the actual evidence it rests on**
([`ADR-0006`](../../docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)). A
developer-only override (`../main/dev/score-levels.ts`) can preview Website Level 3/4 or Delivery
Level 3 before a real provider or peer-to-peer fetching exist -- always named as an override,
never as observed or judged.

**What it depends on.** [`src/contracts/`](../contracts/), and the broker's connection log
*through a contract*, never by reaching into broker internals.

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `trust`, build step 7. First to be cut if the shell or broker overruns.

**What this component exists to prevent.** Overclaiming. It must never present something as
safer than it is; the honesty note about MSE being *obfuscation, not privacy* is the worked
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
entry types would force every consumer, the connection ladder and operation scoring, to merge
three arrays back together to answer "what did this app do, in order". One shape with a
`surface` discriminant avoids that.

**Byte counts and duration are part of that shape, not an optimisation.**
[`ADR-0006`](../../docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)'s
2026-08-25 amendment found the connection ladder was cheaper to fake than to earn: an app
exfiltrating a user's files by opening many short connections to many distinct hosts would
classify at the best available grade, *earned by the attack itself*. The accepted fix was byte
accounting per endpoint plus a byte-asymmetry signal: real swarm traffic is roughly symmetric,
exfiltration is not.

**Omitted connect patterns are carried alongside entries, not folded into them.** An omission is
not something that *happened*; it is a standing fact about the grant ("this pattern can never
appear in `entries`, even if the app tries it"), true for the whole observation window rather
than at one timestamp ([`open-questions.md`](../../docs/open-questions.md) A43).

**The connection ladder never exports a bare pattern label.**
[`ADR-0006`](../../docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)'s
2026-08-25 amendment found the original ladder cheaper to fake than to earn: an app exfiltrating
a user's files over many short connections to many distinct hosts classified at the *best*
available grade, earned by the attack itself. The fix the owner accepted is byte accounting per
endpoint plus a byte-asymmetry signal (real swarm traffic is roughly symmetric, exfiltration is
not), so [`connection-ladder.ts`](connection-ladder.ts)'s `connectionLadder` always returns
`evidence` (the raw counts) and `patternHeuristic` (the label) together, in one object, on every
path. There is no exported function that returns the label alone, and there must never be one.

**`allAllowedWereGranted` checks granted patterns, not declared ones.**
[`A18`](../../docs/open-questions.md) resolved this one layer down
([`connect-src.ts`](../broker/policy/connect-src.ts) derives CSP from what the user actually
granted, never from the manifest's wider declaration), because the manifest itself may claim far more
than was approved. This module follows that precedent structurally: it never sees a `Manifest`
at all, only `ConnectionLogEntry.grantedPattern`, so there is no declared set it could
accidentally compare against instead.

**`OmittedConnectReason` is deliberately smaller than the broker's own vocabulary.**
[`connect-src.ts`](../broker/policy/connect-src.ts)'s `ConnectSrcOmissionReason` distinguishes
reasons an app *author* needs: a malformed pattern is their bug to fix. A trust screen showing
a *user* what broke has no use for that distinction, so whoever wires the real derivation to
this module maps those reasons down to these.

**Pin coverage is counted in bytes, not requests. Provisional, and deliberately easy to
change.** [`delivery-ladder.ts`](delivery-ladder.ts)'s `PinCoverageEvidence` (owner's framing,
2026-09-15: fetching third-party code is not a violation the pin fails to catch, but it costs
trust score, and the old D2 rung had no way to say by how much) keeps both a request count and a byte count
per bucket, but byte totals are the one that answers "how much of the running app". A single
enormous remote script and forty tiny pinned icons are not well described by a request count:
by that measure the pinned side would dominate 40:1 while the app's actual weight ran almost
entirely unpinned. Bytes read that correctly. Both counts are kept anyway, at no extra cost,
so build step 7 can weigh by whichever it renders.

**Byte totals are a floor, never a guess, when a size could not be read.**
[`src/loader/serve/pin-coverage.ts`](../loader/serve/pin-coverage.ts) reads a pinned asset's exact size (the
bytes are already in hand to serve it) but a third-party response's size only from its own
`content-length` header, never by buffering the body to measure it, which would defeat the
streaming `reach/reach.ts` exists for. A chunked or compressed response carries no such header;
its request is still counted, but `bytesIncomplete` is set rather than treating it as zero bytes,
the same "undefined, not zero" discipline `connection-log.ts`'s own `bytesSent`/`bytesReceived`
already use, for the identical reason: an unmeasured byte count is not evidence of a small one.

**`PinCoverageEvidence` is defined once in each direction, not imported across.**
`delivery-ladder.ts`'s copy and `src/loader/serve/pin-coverage.ts`'s `PinCoverageSnapshot` are
structurally identical on purpose: this directory's own README says never reach into another
stream's internals, and `src/loader/README.md` does not list this directory as something it may
import either. The two modules agree on a shape rather than sharing a type, the same relationship
`connection-log.ts` already has with the broker's own (still-unwired) connection log. Running
totals only, kept in memory per origin for the current process run and discarded on restart,
never a per-request history, and never which third-party host was reached beyond what
`connection-log.ts` already legitimately records. This is a count for the indicator, not browsing
history.

**DDOC compares against the current pin, and a matching root alone is not enough**
([`ddoc.ts`](ddoc.ts)). It is computed when the popover asks, from the pin and the tree stored
beside it, so a tree left from an earlier bundle can only fail, never verify. Both the root and
every leaf must match: a right root beside a wrong leaf table would mislead a provider that reads
the table. Its wording states what was compared, "files match the hash tree this site publishes",
and never that the domain's owner published them. The tree sits on the same host as the files
(`ADR-0029`), and saying more would be the overclaim this component exists to prevent.

**The Website level's `ObservedLevel` stops at 2, and 2 means DDOC holds**
([`website-level.ts`](website-level.ts)). Levels 1 and 2 are observations: does DDOC hold. Level
3 and above are judgements about the code itself, and only a Web3 Score provider may give them
(or, in this build, the developer-only override), so `ObservedLevel` itself has no 3 or 4 --
`displayedLevel` is the one place "observed, or overridden" is decided, and every surface shows
that, never `WebsiteLevel.level` directly. DDOC holds when a site's files match the hashes its
owner published: IPFS content, by design, as long as no file failed its check, and an installed
site whose files match the tree it publishes on its own host. How well that anchor is held, a
name proven on Ethereum, a DNSLink or the site's own host, is not part of the level: it is
evidence shown beside it, and the Delivery level's D2 rung already grades a proven name. Mixing
the two would make one number answer two questions.

**The Delivery level (`delivery-ladder.ts`) is a single value on the canonical Connection-to-
network scale, not four independent rungs.** D2 is met only by a `.eth` name proven trustlessly
whose content is itself content-addressed; a TOFU-pinned installed app and a CID reached through
an unproven DNSLink both stay D1 -- each is trusted from a single source, not proven. Nothing
automatic in this build reaches D3, which needs fetching peer-to-peer.
