# ADR-0006: The trust indicator is built from observed behaviour, not claims

- **Status:** accepted
- **Date:** 2026-08-18
- **Type:** product / architecture
- **Decided by:** owner (insisted the full spectrum matters, and proposed the attestation
  model), design per AI recommendation

## Decision
Ship the **full Trustlessity spectrum** in the MVP — sites, connections and operations — built
from two sources that are **automatic and require no judge and no DNS**:

1. **Delivery provenance** — how the app's code reached the machine, and whether it is pinned.
2. **Observed runtime behaviour** — what the app actually did, as seen by the capability broker.

Defer only what genuinely cannot be decided automatically: **source-code honesty** (needs a
judge) and **DDOC** (needs trustless DNS). Build the **hook** that lets judged scores attach
later — bundle-hash pinning — without building a judge.

## Context
An earlier draft of `mvp-scope.md` cut the indicator down to content-addressing only. The
owner rejected that: *"having the full spectrum of Trustlessity scores is so important … if
the site is completely running locally, we can say that this is trustless, the only concern
remains the centralized host."*

That is correct, and it recovers a level that was lost. `Old-Private-Plan/Web3 Verification
levels` had **Level 3 = "the site's full stack runs entirely locally", marked *Automatic***.
It does not appear in the public `web3-score.md` — contradiction **B3** in
`open-questions.md`, resolved here in favour of the private version.

## The insight this rests on
**The capability broker is a trustlessity oracle.** It mediates every socket an app opens
(ADR-0002), so Orivon knows what an app *actually did*, not what it claims. No conventional
browser can report this, because it never sees the app's real network behaviour.

This splits the scoring problem in a way the existing docs do not:

| | decidable by | in MVP? |
|---|---|---|
| **Static claims** — "is this source honest, is it open, does the logic do what it promises?" | human or AI judge | no |
| **Observed behaviour** — "did this app contact a central server? did it run without a server at all? did the code change?" | the broker, automatically | **yes** |

`web3-score.md` assumes scoring means a judge reading source. Observed behaviour is cheaper,
harder to fake, and available today.

**Honest limit, and it must appear in the UI language:** absence of observed bad behaviour is
not proof of good behaviour. An app can behave while watched and misbehave later. The
indicator therefore says *observed*, never *guaranteed*. Overstating this would be precisely
the dishonesty the indicator exists to prevent.

## The three ladders, as shipped

**Delivery** — how the code arrived, and how much trust that costs.

| | | trust cost |
|---|---|---|
| D1 | fetched from a host on every load (an ordinary website) | continuous |
| D2 | fetched once, cached and **pinned**; any change re-prompts | **once** (TOFU, as in SSH) |
| D3 | content-addressed (infohash / CID) — the address *is* the proof | none |
| D4 | content-addressed **and** name resolved trustlessly (ENS) | none — *deferred, needs resolution* |

D2 is the direct answer to the owner's concern about the centralised host: the host is trusted
at install time only. A host compromised **later** cannot silently swap an app that already
holds capability grants.

**Connection** — observed by the broker at runtime. Maps to the existing connection ladder.

| | |
|---|---|
| C1 | contacted arbitrary central servers during use |
| C2 | contacted only hosts declared in its manifest |
| C3 | contacted only P2P peers — **no central server involved at all** |
| +Privacy | all connections carried over Tor or a proxy *(post-MVP)* |

**Operation** — a specific action the user takes.

In the MVP the concrete instance is **Nostr signing via `orivon.id`**: the key never leaves the
machine, no server participates, the operation is fully local. That is honestly a top-level
operation score, and it gives "the user clicks and sees that this operation is fully trustless"
a real thing to point at on day one.

## How judged scores attach later — the attestation model
Proposed by the owner and adopted. A Web3 Score provider does **not** score a *site*; it signs
a statement over a **bundle hash**:

> *provider P asserts: bundle `sha256:ab12…` is Site Level 4* — signed.

Consequences, all of which are improvements over scoring a domain:

- **A score cannot be silently inherited.** Changed content means a changed hash, so an
  altered app cannot wear an old score.
- **Verification is local and offline.** Orivon checks the signature against providers the
  user has chosen. There is no runtime query to the provider, therefore **a score provider
  cannot track users** — a direct answer to the "centralised judge" objection in
  `open-questions.md` A4a.
- **Providers are subscribable feeds**, like apt repositories or filter lists. Several may
  attest the same hash, and disagreement between them is visible rather than hidden.
- **On bundle change, two independent things happen:** the automatic layer breaks its pin and
  re-prompts for consent (a security event), and the judged layer falls back to unassessed
  grey `?` because no attestation matches the new hash. The app keeps working; it loses only
  its judged score until re-attested.

**Known friction:** this creates *lag* — every app update sits unassessed until re-attested,
so fast-moving apps are grey much of the time. This is the genuine basis for the "pay for
faster evaluation" idea in `economical-strategy.md`; reducing lag is a real service worth
charging for. It is unrelated to, and unaffected by, the separate open objection about pricing
*ad placement* by trustlessity level (A4a).

**The MVP ships the hook, not the judge:** bundle-hash pinning and the verification slot.
No provider exists yet, so no judged level is ever displayed in month 1.

## Which of the existing published levels this delivers
- **Site L1** ("standard website, no DDOC") — automatic ✅
- **Site L2** ("supports DDOC") — deferred, needs trustless DNS ❌
- **Site L3** ("full stack runs entirely locally") — automatic ✅ *(reinstated)*
- **Site L4** — the *"executes no external code without consent"* half is automatic via the
  broker ✅; the *"open source"* half needs a judge ❌
- **Site L5 / operation depth** — needs a judge ❌
- **Connection ladder** — automatic in full ✅

## Alternatives considered
- **Content-addressing only** (the earlier draft). Rejected by the owner, correctly: it
  discards local execution, which is both automatic and central to the argument that
  Web3sites are installable.
- **Ship the full published ladder including judged levels.** Rejected: it would require
  claiming levels no machine can verify, with no provider in existence — the exact failure
  mode the indicator exists to prevent.
- **Show nothing until a real provider exists.** Rejected: it would strip the MVP of the one
  feature that makes it recognisably *Orivon* rather than a torrent browser.
- **Attestations over domains rather than bundle hashes.** Rejected per the owner's proposal:
  domain-scoped scores can be silently invalidated by a content change, and would require a
  live provider query, which leaks users to the provider.

## Consequences
- **Cost rises from ~2 days to ~3–4 days.** Accepted: the data already exists inside the
  broker, and the indicator is what ties the MVP to the Orivon brand rather than leaving it a
  torrent client with tabs.
- The broker must keep a **per-app connection log** (in memory, summarised for display), and
  the app cache must be **hash-pinned with re-consent on change** — the latter already
  required by ADR-0005 for integrity.
- Clicking the indicator must show **the actual evidence** — hosts contacted, delivery method,
  pinned hash — not merely a grade. Transparency is the product; the grade is a summary.
- Unassessed states render grey with `?`, per the existing concept images.
- **The public docs need correcting**: reinstate "runs entirely locally" as a site level, and
  mark which levels are automatic versus judged. A public-facing change, not internal.
- Defers cleanly: when a provider or trustless resolution appears, each *adds* levels without
  invalidating anything already shipped.

## Reversibility
- **Cost to reverse:** cheap to extend, expensive to retract. Levels shown once become claims
  users rely on; removing one later reads as a regression.
- **What would make us revisit:** a real score provider emerging (adds judged levels); or
  trustless resolution landing (adds D4 and site L2).
