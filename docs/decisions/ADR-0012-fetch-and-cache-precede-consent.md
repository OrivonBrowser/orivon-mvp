# ADR-0012: Fetch-and-cache is automatic and silent; consent is deferred to first capability use

- **Status:** accepted
- **Date:** 2026-09-03
- **Type:** architecture / security
- **Decided by:** owner

## Decision
Once the browser sees a `<link rel="orivon-manifest">` hint in a page's own delivered HTML — the
only discovery trigger that exists (`ADR-0005` amended below; the old second path, an explicit
"Open as app" menu action, never had an implementation and is cut, `docs/architecture/
capability-api.md`) — it fetches, hashes and caches that app's declared files **automatically and
silently**: no popup, no confirmation, nothing visible to the user. This happens purely because the
hint was seen, with no judgment yet made about whether the user wants anything to do with the app.

The permission prompt is **deferred entirely** to the first moment the app's own code actually
requests a capability (`orivon.net.connect`, `orivon.fs.readFile`, and so on). Until that moment,
the cached files are inert: present on disk, hash-pinned, but unable to do anything, because no
capability is usable without a grant and grants are unaffected by any of this.

**Stated plainly, because it is the uncomfortable part:** an origin the user merely visited — one
carrying a manifest hint, nothing more — can have its code written to the user's disk with **zero
explicit consent** at that point. This ADR accepts that consequence deliberately, for the reasons
in §Reasoning, and states its one currently-unmitigated cost in §Consequences rather than treating
it as free.

## Context
`ADR-0005`'s original "Delivery model" line specified the opposite order: *"fetch → show the
capability grant prompt → cache → run from cache thereafter."* That line was never touched when
PR #63 cut the "Open as app" menu action and rewrote `capability-api.md`, `mvp-scope.md` and
`ARCHITECTURE.md` around the fetch-then-cache-then-defer-consent model — so as of that PR, two
accepted documents in this repository stated incompatible answers to the same question: does the
browser ever put a website's files on the user's disk before asking them anything?

A review pass (`rev-63`) caught the contradiction (finding B1) before merge: `capability-api.md`
cited "the ADR-0005 flow (fetch → cache → pin)" by name, as though ADR-0005 already said that —
it did not. This is not a new disagreement invented by that PR; the *old* `capability-api.md` text
("grant prompt → fetch → cache → pin") already used a different order than ADR-0005's own text
("fetch → grant prompt → cache"). PR #63 made the drift materially worse — full decoupling of the
prompt from install, not just a swap of two adjacent steps — while asserting the two documents
already agreed.

The owner has now decided, in plain language: *"Download quietly first; ask permission only when
the app actually tries to do something. This is what #63 already assumes — ADR-0005 gets formally
amended (in place, dated correction block, this repo's own convention) to match, not the other way
around."* This ADR records that decision formally and amends `ADR-0005` to agree with it (see
§Consequences and the amendment block in `ADR-0005` itself).

## Alternatives considered

**Ask permission before any fetch happens at all** — `ADR-0005` as originally written; show the
grant prompt, then fetch and cache only after the user accepts. Rejected. Every page that carries
a manifest hint would trigger a popup before the user has any idea whether they even want to use
that app — reached the instant a page loads, based on nothing the user did. Two failure modes
follow from that, and both defeat the point of asking at all:

- **Prompt fatigue.** A popup appearing on ordinary browsing, disconnected from any action the
  user took, trains users to reflexively dismiss it — exactly the "click through cargo cult" this
  repo's own `ADR-0005` amendment (publisher-key continuity) already named as a real failure mode
  in a narrower case. Training that reflex on installation makes the *later*, meaningful prompt
  (the one that actually grants network or filesystem access) less likely to get real attention,
  not more.
- **A permission gauntlet.** If simply loading a page that happens to carry a manifest hint can
  interrupt browsing, ordinary use of the web starts to feel adversarial toward the user — the
  opposite of what a trust indicator (`ADR-0006`) is trying to build.

The prompt is only meaningful when it is tied to something the user can concretely understand:
*"this wants network access,"* not *"this MIGHT eventually want something, from a page you just
happened to load."* Deferring the ask to the moment a real capability is actually requested keeps
every prompt shown backed by a concrete, nameable thing. This is also not a novel move for a
browser to make: an ordinary web browser already caches an ordinary page's own assets — HTML, JS,
CSS, images, service-worker resources — with no permission dialog of any kind, because caching a
page's own inert files carries no capability. Orivon's fetch-and-cache step is the same kind of
event; what changes at the next step (a capability request) is genuinely new, and that is where
this design puts the prompt.

**Fetch but do not cache to disk until first capability use** — keep the manifest-declared files
in memory (or refetch them) until the app's code first asks for a capability, and only persist to
disk at that point. Considered as a middle option between "prompt before anything" and "cache
silently, always." Rejected: it would mean re-fetching the app's files from the network on every
single visit to a site the user has not yet granted any capability to, since nothing durable is
kept between visits. That defeats the actual point of a local, hash-pinned cache — offline
availability and fast repeat loads — for exactly the population of sites (browsed once or twice,
capability never yet requested) where a user is most likely to eventually accept the app and most
benefits from it already being on disk. It also does not remove the "code was written to disk
before consent" property this ADR accepts; it only delays it by one visit, at the cost of
network traffic and latency on every visit before that, while gaining nothing for privacy or
consent — the fetch itself is still unsolicited and still happens before any user decision.

## Reasoning
The core argument is the popup-fatigue one above, stated once more directly: **consent is only
worth asking for when it is legible.** "This site wants to connect to a server" is a decision a
user can actually reason about. "This site might, at some future point, want something" is not a
decision at all — it is a checkbox nobody reads, on a browser whose entire differentiator is that
its permission prompts are supposed to *mean something* (`mvp-scope.md`'s journey 1, the flagship
clip, exists specifically to put a real, legible grant prompt on camera). Moving consent to
install time would cheapen the one moment this product is built around.

Separately, this mirrors how the web already works. Nothing asks a user's permission for an
ordinary page to populate its own browser cache or `Cache Storage` — caching is understood to be
inert, reversible, and not itself a capability. Orivon's fetch-and-cache step has exactly that
shape: it places files on disk, and those files can do nothing until a capability is granted. The
thing that is actually new relative to the ordinary web — an app *reaching* the network or
filesystem under a real grant — is exactly the thing this design still gates, at exactly the
moment it starts to matter.

**What this explicitly does NOT change:** capability *grants* remain exactly as gated as before
this ADR. Nothing about network access, filesystem access, or any other capability becomes easier
to obtain, is granted implicitly, or skips the grant prompt. The only thing that moved is the
fetch-and-cache step — getting the app's inert files onto disk — which now happens earlier and
unconditionally, decoupled from any grant decision. `security-model.md`'s threat model for T18
(origin spoofing in the grant prompt) and T21 (unpinned code reaching the app) are unaffected:
both concern what happens once a capability is requested, and this ADR does not touch that path.

## Consequences

**Amends `ADR-0005`.** Its "Delivery model" line previously read *"fetch → show the capability
grant prompt → cache into that app's storage domain → run from cache thereafter."* That line is
now wrong and is corrected in place, with a dated amendment block pointing here, following this
repository's convention for a reversed decision (`ADR-0004`'s "Reversal recorded" block). The
original wording is kept, visible, not deleted — see `ADR-0005` itself for the exact diff.

**Known, currently-unmitigated gap — accepted anyway, with a condition.** Two real problems exist
in the design as specified, and neither is fixed by this ADR:

1. **No cross-app disk quota.** Each app's bundle is capped individually at 64 MiB
   (`MAX_BUNDLE_BYTES`, `src/broker/policy/bundle-hash.ts`), but nothing limits how many distinct
   origins can each silently claim their own 64 MiB. A user who never grants a single capability
   can still accumulate an unbounded number of cached, unused app bundles purely by loading pages
   that carry a manifest hint.
2. **No cleanup of superseded versions.** When an app's manifest changes (a new hash, per
   `ADR-0009`), the loader pins the new bundle; nothing removes the old one. Every version an app
   has ever shipped that this browser fetched stays on disk indefinitely.

Both gaps are filed as one entry, `docs/open-questions.md` A58 — found independently by a parallel
review pass on PR #62 while this ADR was being written, covering exactly these two sub-cases.
(`A57` was claimed at the same time by a different, unrelated fix, `GrantLedger`'s own missing
persistence — the two-lane numbering collision this caused was resolved by keeping A58's single
entry rather than duplicating it under a second number.)

Neither is fixed here, and that is a deliberate, bounded acceptance rather than an oversight:
**nothing in the current tree wires the discovery trigger to anything live.** `src/loader/
subsystem.ts` ships deliberately inert (no `beforeReady`/`afterReady`); no code path today can
reach `createLoader.load()` against a real, attacker-influenced `hintedUrl` in the shipped
product (`docs/open-questions.md` A46, A50). Nothing this design describes can happen to a real
user yet. That gives real time to design and build the quota and cleanup mechanisms before it
matters — but it is a deadline, not an indefinite pass: **both gaps must be closed before the
discovery trigger is ever wired to the real browser shell.** Wiring the trigger while either gap
is open would ship an unbounded, unauthenticated disk-fill vector to real users on day one.

## Reversibility
- **Cost to reverse:** moderate. Reverting to "prompt before fetch" is a design and UX change, not
  a data-format or protocol change — no cached bundle, grant record, or hash pin depends on
  *when* consent was asked, only on *whether* it was. The cost is mostly in re-litigating the UX
  (a prompt has to reappear somewhere, and journey 2 in `mvp-scope.md` would need rewriting again)
  and in the fact that, once real users have experienced silent installs, reintroducing an
  install-time prompt reads as the product becoming more invasive, not less — a harder sell than
  shipping it that way from the start.
- **What would make us revisit:** either (a) the quota/cleanup work in §Consequences turns out to
  be genuinely hard to build correctly before the discovery trigger needs wiring, making "ship
  fetch-then-defer without a quota" the practical default under schedule pressure — at which point
  the tradeoff this ADR accepts needs re-examining with real deadline pressure in the room, not
  hypothetically; or (b) telemetry or user reports after launch show disk usage from
  never-consented-to apps is a real, noticed problem rather than a theoretical one. Not "if it
  turns out badly" in the abstract — a specific, checkable signal in either case.
