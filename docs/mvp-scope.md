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

**100 active users in EU/USA, where active = 25 hours/month of `activeSec`.**

That is ~50 min/day of *actual use*, i.e. daily-driver usage. This metric, not the long-term
vision, decides what is in scope.

> **Corrected 2026-08-25 (owner decision).** Telemetry previously measured how long the app was
> *open*. A torrent client seeds in the background — that is what it is for — so a user who
> pasted one magnet and left the tab open would accumulate 24 h/day and cross 25 h/month on day
> one, having used the product exactly once. The metric was satisfiable by the least engaged
> possible user, which made the daily-use hypothesis unfalsifiable in the direction that
> flatters it.
>
> `ADR-0004` now reports **`activeSec`** (window focused, user interacting within an idle
> timeout) separately from **`backgroundSec`** (running, idle, seeding). The metric is stated
> on `activeSec`. This makes the target genuinely harder, which is the point.

Measured per `ADR-0004` (first-run explicit choice, self-hosted), retaining an estimated
85–90% of installs.

> **The former "115–130 installs" figure was wrong** and is withdrawn. It divided 100 by the
> telemetry consent rate and applied no retention and no activation — assuming every install
> becomes someone who uses the product 50 minutes a day. An honest chain (download → still
> installed at day 7 → reaches 25 h/month) puts the requirement in the region of **thousands of
> downloads, not hundreds.** Also worth stating plainly: 25 h/month cannot be observed until
> ~30 days after ship, so **the metric resolves around month 3, not month 1.**
>
> Sizing the funnel and choosing channels is **owner-side work, outside this repository.**

## The journeys that must work

1. **The clip.** First run → paste a magnet link → the real grant prompt ("connect to any
   computer on the internet") → video playing in under 30 seconds, no torrent client
   installed. The prompt is in the clip **deliberately** (owner decision): the permission
   system is the differentiator, and the flagship holds zero silent privileges. This is
   simultaneously the product, the proof, and the distribution asset.
   *v0 plays MP4/H.264 only — use a known-good MP4 torrent, and state the format limitation
   in-product rather than letting users discover it on their own magnets.*
2. **The app from a URL.** Type a URL → the page's own HTML hints that it has a manifest →
   the browser fetches and caches it → the app runs, asking for the grant prompt only once it
   actually calls for a capability, with real network access delivered from that URL and
   nowhere else.
   **Added 2026-08-25.** The audit found that no journey demonstrated URL delivery — journey 1
   runs a pre-cached app, journey 3 loads a local directory — even though URL delivery is the
   thesis, and is why the shim moved into month 1, why the spike exists, and why the flagship
   cannot take the cheap main-process path. Cheapest honest fix: serve the *same* torrent app
   from a second origin. A static deploy, not a second app.
   **Corrected 2026-09-03, owner decision.** This previously read "the browser offers 'Open as
   app'" — a discrete menu action that does not exist and will not: a Web3site is the URL, not
   a separate thing a user converts a website into. See `capability-api.md`'s "How a URL
   becomes an app" for the corrected mechanism (its own 2026-09-03 correction block).
3. **The identity.** Open any Nostr client on the web → one connect prompt → signed in, and it
   is the *same* identity in every client — no extension installed, no seed phrase, no setup.
   *Proves the identity model, but claims little about the thesis: `window.nostr` injection is
   what nos2x and Alby already do in Chrome. It is a cheap sticky feature, not the proof.*
4. **The developer.** Write a JSON manifest and a frontend → load unpacked → an app with real
   network access, in an afternoon.

If these work, the MVP has done its job. If journey 1 does not clip well, the plan fails
regardless of the others.

---

## IN — essential to the core thesis

| Item | Why it is essential |
|---|---|
| Shell — tabs, omnibox, back/forward | It has to be a browser, or the thesis is untested |
| Address-bar search via DuckDuckGo | **Owner override, 2026-08-26** — added at build step 1, not in the original scope pass. Non-address input needs *some* resolution or the omnibox rejects plain text outright; DuckDuckGo chosen over a settings-based picker (no settings screen exists in month 1) and over addresses-only. Known limitation, stated in-product: search text leaves the machine (`build-plan.md` §5 known-limitations line) |
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
| **Bookmarks bar** — star a page, open it from the bar, unstar it | **Owner override, 2026-08-28** — not in the original scope pass; arrived bundled with a chrome restyle. Cheap (a JSON file and three IPC commands, `ADR-0003`), and a browser with no way to keep a page is not a plausible daily driver — `activeSec` is what the success metric actually measures |
| Real tab favicons | **Owner override, 2026-08-28** — a fix-round follow-on to the chrome restyle. Known limitation, same shape as the DuckDuckGo search row above: fetching a visited site's favicon is main-process network egress to whatever host serves that icon (`src/main/favicon.ts`), capped and re-encoded to a `data:` URL specifically so the privileged chrome view itself never makes the request |
| **New-tab dashboard** — a search box, every bookmark as a tile, and inert Torrent/Nostr shortcut tiles | **Owner override, 2026-08-28** — replaces `about:blank`. Styled as a grid to match the long-term vision's layout (`orivon-docs`'s `dashboard-app.md`), but populated with only what is real today: no Wallet, Network or App-Store tiles, and no pluggable widget system underneath it — that platform is the OUT row below, deliberately not pulled forward. The Torrent and Nostr tiles are honest placeholders (`disabled`, with a tooltip naming the build step each arrives in), the same pattern already shipped for the toolbar's own not-yet-built icons |

## OUT — important but deferrable

Real parts of Orivon, deliberately not in month 1.

| Item | Why deferred |
|---|---|
| **Judged** score levels (site L4 "open source", L5) | No provider exists yet. The MVP ships bundle-hash pinning so attestations can attach later without rework. `ADR-0006` |
| DDOC, and site L2 | Blocked on trustless resolution — its DNS anchor is forgeable on ICANN domains. A4b |
| Trustless resolution (ENS and friends) | Real work; also a **prerequisite for DDOC and site-level scores** |
| IPFS / Arweave data gathering | Second delivery path; HTTPS suffices to prove the model |
| App store | Needs apps first. Developer mode covers month 1 |
| Dashboard **widget/extension platform** — installed apps placing their own widgets, an App Store, Wallet and Network widgets | Pure surface area; zero contribution to the metric. (The new-tab page itself — a grid with real bookmarks and two inert app shortcuts — shipped 2026-08-28 as an IN-table item above; this row is the pluggable platform underneath it, not the page) |
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

Measurable claim: **app #3 costs dramatically less than app #1.**

> **Made evaluable, 2026-08-25.** The plan contained no app #3, and app #2 (Nostr) touches no
> `net`, no `fs`, no manifest and no grant — so the comparison measured nothing. App #3 is now
> the **e2e fixture app**, which is needed anyway: a minimal app served over HTTP with a real
> manifest, built only against the public API, exercising `orivon.net` and `orivon.fs` through
> the shim. It doubles as the developer-mode example for journey 4 and the docs.
> **Record hours per build step from day 1** — "cost" needs a unit, and nobody reconstructs
> their own hours afterwards.

## What would count as failure

Worth agreeing in advance, so the result is interpretable either way:

- The week-0 spike fails **and** the `utilityProcess` fallback also underperforms → the
  capability model does not carry real workloads.
- The clip is built and posted to the right communities and produces no organic traction →
  the daily-use hypothesis is wrong, and the flagship should change before anything else does.
  *(Owner-side: this needs a named community list, a window and a number before it can fire.
  As written it is unfalsifiable — any outcome supports "wrong community, try another".)*
- App #3 costs as much as app #1 → the API is not generic; it is a torrent client with extra
  steps.
