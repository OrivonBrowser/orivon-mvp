# MVP scope

> **Draft — owner has veto over every classification below.**
> The long-term vision lives in `orivon-docs` and in the OrivonBook drafts
> (`docs/inventory.md` §1b). This document is deliberately narrower than both.

## What the MVP proves

That a browser can run applications which are **impossible in Chrome** — reaching the
network and the filesystem directly under user-granted, per-app capabilities — while those
applications are ordinary web frontends delivered from a URL.

Everything else in Orivon's vision is downstream of that being true.

## Success metric

**100 active users in EU/USA, where active = 25 hours/month.**

That is ~50 min/day, i.e. daily-driver usage. It cannot be reached by novelty; it requires
the product to genuinely replace something the user does anyway. This metric, not the
long-term vision, decides what is in scope.

Measured per `ADR-0004` (opt-out, disclosed, self-hosted), which retains 85–95% of installs.
Plan for roughly **110–120 installs** to measure 100 active users.

## The three journeys that must work

1. **The clip.** First run → paste a magnet link → video is playing in under 30 seconds, with
   no torrent client installed. This is simultaneously the product, the proof, and the
   distribution asset.
2. **The identity.** Open any Nostr client on the web → one connect prompt → signed in, and it
   is the *same* identity in every client — no extension installed, no seed phrase, no setup.
3. **The developer.** Write a JSON manifest and a frontend → load unpacked → an app with real
   network access, in an afternoon.

If all three work, the MVP has done its job. If journey 1 does not clip well, the plan fails
regardless of the other two.

---

## IN — essential to the core thesis

| Item | Why it is essential |
|---|---|
| Shell — tabs, omnibox, back/forward | It has to be a browser, or the thesis is untested |
| **Capability broker** — manifest, grants, per-origin enforcement | This *is* the product. `ADR-0002` |
| **`orivon-node-shim`** | Load-bearing: without it the flagship cannot be a URL-delivered app. `ADR-0005` |
| URL-addressed app fetch + cache + integrity check | The "apps are URLs" claim. `ADR-0005` |
| **Torrent app with streaming** | The flagship and the only tier-4 app. `ADR-0001` |
| Nostr via injected NIP-07 over `orivon.id` | ~1 day, proves the identity model, zero frontend written |
| Per-app storage isolation + disk usage UI | Follows directly from the flagship. `ADR-0003` |
| **Trust indicator — full spectrum from observed behaviour** | Delivery ladder (incl. hash-pinning/TOFU), connection ladder, and operations. Automatic; no judge, no DNS. Ships the attestation *hook*, not a judge. `ADR-0006` |
| Developer mode — unpacked loader + docs | Permissionless is a core value, and it recruits the A+ developers. `ADR-0002` |
| Telemetry + first-run disclosure + "what was sent" page | Without it the metric is unfalsifiable. The disclosure UI is not optional. `ADR-0004` |
| Packaging — **Linux first** (AppImage + deb) | No code-signing cost, and the target audience skews Linux |
| **Run-from-source on Windows and macOS** | `npm install && npm start` sidesteps SmartScreen and Gatekeeper without buying certificates, widens the audience, and self-selects contributors. Forces a pure-JS dependency policy |

## OUT — important but deferrable

Real parts of Orivon, deliberately not in month 1.

| Item | Why deferred |
|---|---|
| **Judged** score levels (site L4 "open source", L5) | No provider exists yet. The MVP ships bundle-hash pinning so attestations can attach later without rework. `ADR-0006` |
| DDOC, and site L2 | Blocked on trustless resolution — its DNS anchor is forgeable on ICANN domains. A4b |
| Trustless resolution (ENS and friends) | Real work; also a **prerequisite for DDOC and site-level scores** |
| IPFS / Arweave data gathering | Second delivery path; HTTPS suffices to prove the model |
| App store | Needs apps first. Developer mode covers month 1 |
| Dashboard widget grid | Pure surface area; zero contribution to the metric |
| Funds-bearing wallet | Different security model entirely from per-origin identity |
| `subprocess` and `hid` capabilities | No MVP app needs them, and they are the largest attack surface |
| Identity export / backup | First thing to add once identity has value to users |

## LATER — useful, clearly post-MVP

`orivon-runtime` (Wasmtime — arrives when untrusted third-party apps or mobile do) ·
Chromium fork · mobile · Web3 search · Tor / proxy chains · client profiles ·
wallet Crypto and Address-book layers plus `CapabilityDescriptor` · cross-device sync ·
Windows and macOS packaging with code signing.

## UNRELATED to the MVP

DAO and tokenomics · advertising and featured placement · governance · community growth
systems · merit tracking. These are organisational, not product, and none moves the metric.

---

## Explicit non-goals

State these publicly. They prevent both scope creep and disappointed users.

- **Not a wallet.** No funds, no seed phrase, no send/receive.
- **Not an app store.** Developer mode, not a marketplace.
- **No trust scores requiring human or AI judgement.** The indicator claims only what the
  machine can verify locally. Claiming more would be exactly the dishonesty the indicator
  exists to prevent.
- **No Chromium fork**, and no pretence that Electron is the final architecture.
- **No mobile.**
- **No sync**, and no Orivon-operated server for user data. Infrastructure is limited to the
  telemetry ingest endpoint plus static hosting of first-party app bundles (e.g. GitHub
  Pages/Releases).
- **Untrusted apps are not contained.** Developer mode is genuinely "at your own risk"; a
  Node broker cannot sandbox hostile code. This is what `orivon-runtime` later fixes.
- **Bitcoin Core does not run in a tab.** That remains a long-term goal for the execution
  layer, not an MVP claim.

## The genericity test

The torrent and Nostr apps must be built **using only the public capability API** — no
privileged shortcuts, no special-casing in the shell. They are the API's first consumers and
its validation suite.

Measurable claim: **app #3 costs dramatically less than app #1.** If it does not, the design
failed and we learn it in week 2 rather than month 6.

## What would count as failure

Worth agreeing in advance, so the result is interpretable either way:

- The week-1 spike fails **and** the main-process fallback also underperforms → the
  capability model does not carry real workloads.
- The clip is built and posted to the right communities and produces no organic traction →
  the daily-use hypothesis is wrong, and the flagship should change before anything else does.
- App #3 costs as much as app #1 → the API is not generic; it is a torrent client with extra
  steps.
