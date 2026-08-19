# Readiness report

**Purpose:** the gate before implementation. Owner signs off, or corrects, and then code starts.
This is a synthesis — it does not restate what the linked documents already say.

**Date:** 2026-08-18 · **Recommendation: ready to build, conditional on the week-0 spike.**

---

## Product readiness

**Clear.**
- What the MVP proves, and the metric that judges it: 100 active users in EU/USA at
  25 h/month. The metric — not the long-term vision — decides scope (`mvp-scope.md`).
- The flagship, with reasoning recorded so it is not re-litigated (`ADR-0001`).
- Three journeys that must work: the clip, the identity, the developer.
- Everything classified: in / deferrable / later / unrelated, plus explicit public non-goals.
- Failure conditions agreed in advance, so the outcome is interpretable either way.

**Uncertain, deliberately.**
- **Whether 25 h/month is reachable at all.** This is the hypothesis, not a risk to mitigate.
  The torrent flagship is the best available bet because it is genuinely daily-use, impossible
  in Chrome, cheap, audience-matched, and it clips.
- **Distribution.** No existing presence in the target communities, ~€50 budget. Mitigated by
  the clip existing at end of week 2 rather than end of month, and by run-from-source widening
  reach past Linux.

## Technical readiness

**Decided** — six ADRs, all with reversibility recorded:

| | |
|---|---|
| `ADR-0001` | BitTorrent streaming is the flagship |
| `ADR-0002` | The capability API is the durable asset; WASM deferred, not cancelled |
| `ADR-0003` | Local-first storage, per-origin isolation, no Orivon server for user data |
| `ADR-0004` | Telemetry: opt-out, disclosed, self-hosted, inspectable |
| `ADR-0005` | Apps are URL-addressed and cached, never bundled |
| `ADR-0006` | Trust indicator from observed behaviour; attestations over bundle hashes |

Also settled: the v0 API surface (`capability-api.md`), compatibility tiers
(`app-compatibility.md`), threat model (`security-model.md`), and a dependency-ordered plan
with a testing and platform policy (`build-plan.md`).

**Uncertain.**
- **Renderer-side webtorrent throughput.** The one unknown that changes the architecture.
  Resolved by a 2-day timeboxed spike before anything else starts, with a documented fallback.
- **NIP-07 conformance** across real Nostr clients — cheap to verify, small blast radius.
- **The `+Privacy` level placement** and the canonical **DDOC** expansion — both awaiting an
  owner decision in `glossary.md`. Neither blocks code.

## Major risks

1. **The daily-use hypothesis is simply wrong.** Highest-impact, and the whole point of
   measuring. Detected by: the clip lands in the right communities and produces nothing.
   Response: change the flagship, not the marketing.
2. **The spike fails and the fallback is also inadequate** → the capability model does not
   carry real workloads. Detected in week 0 for 2 days' cost.
3. **Scope creep out of the vision docs.** The corpus is large, coherent and seductive, and
   the developer is solo. Mitigated by non-goals and by "absent from IN means out".
4. **A broker vulnerability.** Authorisation, not containment — stated openly rather than
   papered over. T1, T3 and T12 in `security-model.md` are the ones most likely to be got
   wrong; T12 (DNS rebinding against manifest patterns) is the subtlest.
5. **Telemetry discovered rather than announced.** Cheap to avoid, expensive if mishandled.
   Pre-announcement is a launch-blocking task.
6. **A dependency pulling in native modules**, silently breaking Windows/macOS run-from-source.

## Recommended architecture

Unchanged from `ADR-0002`, restated once:

```
renderer (sandboxed)  →  orivon.* capability API  →  broker (main process)  →  OS
                              ↑ durable                    ↑ swappable
```

The interface is the asset. The Electron shell is disposable, and the implementation beneath
the API moves — Node now, Wasmtime later, Mojo in a Chromium fork after that — without any app
noticing. That property, not the choice of Electron, is what keeps the Chromium path open.

## Implementation phases

Detail in `build-plan.md`. Critical path:

```
spike → shell → broker → shim → app loader → torrent app → THE CLIP
```

| | |
|---|---|
| Week 0 | Spike (gate) · scaffold |
| Week 1 | Shell · broker skeleton |
| Week 2 | Shim · app loader · torrent app → **clip exists, distribution starts** |
| Week 3 | Trust indicator · Nostr · telemetry |
| Week 4 | Developer mode + docs · packaging · pre-announce · ship |

## Remaining questions that materially affect implementation

Only two, and neither blocks starting:

1. **Canonical DDOC expansion** and **`+Privacy` level placement** (`glossary.md`). Needed
   before any public doc correction, not before code.
2. **Three open items in `capability-api.md`**: whether `net.listen` is grantable to unsigned
   apps; whether grants key on origin or origin + manifest version; whether `fs.quotaBytes` is
   enforced or advisory. All are decidable during step 2 and I will propose defaults if you
   would rather not decide them now.

Everything else open (`open-questions.md`) is post-MVP: DDOC soundness, ENS resolution,
judged score levels, the advertising structure.

---

## What I need from you

**A go/no-go, plus any final constraints or corrections.**

Two things worth saying explicitly before you sign:

- **Your best use of the coming month is not this repository.** It is the demo clip, the
  landing page, the telemetry pre-announcement, and picking the communities. That is the
  critical path to 100 users and it is the part I cannot do.
- **The public docs now disagree with these decisions in three places**: the bitcoind claim,
  the missing "runs entirely locally" trustlessity level, and the roadmap ordering (trustless
  resolution is a prerequisite for DDOC and site-level scores). Those are public-facing
  corrections, on your side of the line, and worth doing before the MVP draws attention to them.
