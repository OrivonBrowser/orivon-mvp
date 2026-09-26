# MVP scope

> **Draft.**
> The long-term vision lives in `orivon-docs` and in the OrivonBook drafts
> (`docs/inventory.md` §1b). This document is deliberately narrower than both.

## What the MVP proves

That a browser can run applications which are impossible in Chrome, reaching the network and
the filesystem directly under user-granted, per-app capabilities, while those applications are
ordinary web frontends delivered from a URL.

Everything else in Orivon's vision is downstream of that being true.

## Success metric

**100 active users in EU/USA, where active = 25 hours/month of `activeSec`.**

That is ~50 min/day of *actual use*, i.e. daily-driver usage. This metric, not the long-term
vision, decides what is in scope.

`ADR-0004` reports `activeSec` (window focused, user interacting within an idle timeout)
separately from `backgroundSec` (running, idle, syncing, seeding), and the metric is stated on
`activeSec`. That distinction is the whole difficulty of the target. Some apps do their real work
in the background, as a node syncing or a torrent client seeding does, so a metric counting time
the app was merely *open* would let a user who started one and left the tab there accumulate
24 h/day and cross 25 h/month on day one, having used the product exactly once. Counting only
active time makes the target genuinely harder, which is the point.

Measured per `ADR-0004` (first-run explicit choice, self-hosted), retaining an estimated
85-90% of installs.

An honest funnel chain (download → still installed at day 7 → reaches 25 h/month) puts the
requirement in the region of thousands of downloads, not hundreds. 25 h/month cannot be observed
until ~30 days after ship, so the metric resolves around month 3, not month 1. Sizing the funnel
and choosing channels happens outside this repository.

## The journeys that must work

1. **A desktop app, from a URL.** Open the address of an ordinary Node.js or Electron desktop
   app ported to Orivon (FreeTube, Element) → one dialog asks, in plain words, for what it needs
   → the app runs in a tab with the network and disk access its desktop version had, and no
   desktop client installed. A port is the app's own frontend, never forked, plus one bridge
   file (`ADR-0020`). This is the thesis at its most literal: software that had to be a desktop
   app, running as a web page.
2. **The app from a URL.** Type a URL → the page's own HTML hints that it has a manifest →
   the browser fetches and caches it → a single dialog asks, in plain words, for everything the
   manifest declares, before the app's own code runs → accepting installs it, with real network
   access delivered from that URL and nowhere else. The fetch-and-cache step before that dialog
   is automatic and silent by design (`ADR-0012`), with no install confirmation and no "this is
   now an app" indicator, so nothing marks the moment an origin becomes a cached app. The
   consent dialog is the first and only visible moment in the journey.
   There is no "open as app" action: a Web3site is the URL, not a separate thing a user converts
   a website into. See `capability-api.md`'s "How a URL becomes an app" for the mechanism.
3. **A name on Ethereum.** Type `name.eth` → the page loads, and every byte of it was checked on
   this machine against what the Ethereum chain says the name points to. The servers that
   answered were trusted for availability only, never for correctness. The site-info popover
   shows the evidence: the name proved, the content verified against its CID, and DDOC anchored
   in the name's ENS record. An app delivered this way is consented and installed exactly as in
   journey 2.
4. **The developer.** Write a JSON manifest and a frontend → load unpacked → an app with real
   network access, in an afternoon.

If these work, the MVP has done its job. None of them is yet named as the distribution asset
(`open-questions.md` A249).

---

## IN: essential to the core thesis

| Item | Why it is essential |
|---|---|
| Shell: tabs, omnibox, back/forward | It has to be a browser, or the thesis is untested |
| Address-bar search via DuckDuckGo | Added at build step 1, not in the original scope pass. Non-address input needs *some* resolution or the omnibox rejects plain text outright; DuckDuckGo chosen over a settings-based picker (no settings screen exists in month 1) and over addresses-only. Known limitation, stated in-product: search text leaves the machine (`README.md` §Known limitations of v0) |
| **Capability broker**: manifest, grants, per-origin enforcement | This *is* the product. `ADR-0002` |
| **`orivon-node-shim`** | Load-bearing: without it a Node.js app cannot run from a URL. `ADR-0005` |
| URL-addressed app fetch + cache + integrity check | The "apps are URLs" claim. `ADR-0005` |
| **DDOC**: a site publishes its bundle hash tree, the Web3 Score page shows whether the pinned bundle matches it, and a `.eth` name anchors the tree's root in its ENS record | The publisher's own statement of which bundle it ships, which a Web3 Score provider can attest to; the evidence behind site L2. Automatic, shown as evidence, and never blocking a load. The same-host tree is built with the app loader (build step 4). The ENS anchor, which catches a host compromised well enough to rewrite both its files and its tree, arrives with build step 6. `ADR-0029` |
| **UDP sockets** (`net.udpBind`) | DHTs, peer exchange and most P2P protocols need real UDP, not just TCP, and a web page can open neither. Part of what makes an app impossible in Chrome |
| **Node.js apps, ported**: existing Node.js and Electron desktop apps running from a URL over `orivon.*` | The platform's test cases, and journey 1. A real app finds the gaps a fixture never will. An app qualifies by running in the Node environment, WebAssembly components included, not by being JavaScript (`ADR-0036`). Ported in `orivon-ports`, never forked; nothing in this repository depends on that checkout (`ADR-0020`) |
| **ENS names and IPFS delivery, trust-minimised** | A `.eth` name resolved by a light client that proves the name's record, and IPFS content verified block by block against its CID, so a server supplies availability and never correctness. Adds the delivery ladder's D3 and D4 rungs and DDOC's ENS anchor. Journey 3 |
| Identity seed in the OS keyring; `orivon.secrets`, an app's own origin-bound encrypted secret | `orivon.id` cannot survive a restart without the first half. Owner-requested; needed by two ported apps' own hand-off items (Element's pickle key, AirGap Vault's non-keyring fallback). `ADR-0033` |
| Per-app storage isolation + disk usage UI | Every app that writes to disk needs both. `ADR-0003` |
| **Trust indicator: the full spectrum, observed and judged** | Delivery ladder (incl. hash-pinning/TOFU), connection ladder and operations, automatic from observed behaviour. Judged levels (site L4's "open source" half, site L5, operation depth) come from a Web3 Score provider's attestation over the bundle hash; in this build that provider need not be trustless, and may run locally. Every judged level names its provider and is shown apart from what the machine observed. `ADR-0006` |
| Per-site permissions popover | A Chrome-style popover off the address pill: the connection row (opening the trust indicator's own delivery evidence), one switch per capability or picked path a site has asked for, and its Cookies and site data. `d-0037` |
| Developer mode: unpacked loader + docs | Permissionless is a core value, and it recruits the A+ developers. `ADR-0002` |
| Telemetry + first-run disclosure + "what was sent" page | Without it the metric is unfalsifiable. The disclosure UI is not optional. `ADR-0004` |
| Packaging: **Linux first** (AppImage + deb) | No code-signing cost, and the target audience skews Linux |
| **Run-from-source on Windows and macOS** | `npm install && npm start` sidesteps SmartScreen and Gatekeeper without buying certificates, widens the audience, and self-selects contributors. Forces a no-native-modules policy on Orivon's own dependencies, not on the apps it runs |
| **Bookmarks bar**: star a page, open it from the bar, unstar it | Not in the original scope pass; arrived bundled with a chrome restyle. Cheap (a JSON file and three IPC commands, `ADR-0003`), and a browser with no way to keep a page is not a plausible daily driver, since `activeSec` is what the success metric actually measures |
| Real tab favicons | A fix-round follow-on to the chrome restyle. Known limitation, same shape as the DuckDuckGo search row above: fetching a visited site's favicon is main-process network egress to whatever host serves that icon (`src/main/browsing/favicon.ts`), capped and re-encoded to a `data:` URL specifically so the privileged chrome view itself never makes the request |
| **New-tab dashboard**: a search box, every bookmark as a tile, and two inert shortcut tiles (Torrent, Nostr) | Replaces `about:blank`. Styled as a grid to match the long-term vision's layout (`orivon-docs`'s `dashboard-app.md`), but populated with only what is real today: no Wallet, Network or App-Store tiles, and no pluggable widget system underneath it, because that platform is the OUT row below, deliberately not pulled forward. The Torrent and Nostr tiles are honest placeholders (`disabled`, with a tooltip saying each is an idea not in this build), the same pattern already shipped for the toolbar's own not-yet-built icons |

## OUT: important but deferrable

Real parts of Orivon, deliberately not in month 1.

| Item | Why deferred |
|---|---|
| DDOC anchored in DNS (the vision's `DDOC <version> <hash>` record) | Scope: the ENS record is this build's off-host anchor. On ICANN domains without DNSSEC the record is forgeable anyway (`open-questions.md` C1). `ADR-0029` |
| Arweave, and content-addressed stores other than IPFS | IPFS is this build's second delivery path, and one proves the model |
| App store | Needs apps first. Developer mode covers month 1 |
| Dashboard **widget/extension platform**: installed apps placing their own widgets, an App Store, Wallet and Network widgets | Pure surface area; zero contribution to the metric. (The new-tab page itself, a grid with real bookmarks and two inert app shortcuts, shipped 2026-08-28 as an IN-table item above; this row is the pluggable platform underneath it, not the page) |
| Funds-bearing wallet | Different security model entirely from per-origin identity |
| `subprocess` and `hid` capabilities | No MVP app needs them, and they are the largest attack surface |
| Identity export / backup | First thing to add once identity has value to users |

## LATER: useful, clearly post-MVP

`orivon-runtime` (Wasmtime; arrives when untrusted third-party apps or mobile do) ·
Chromium fork · mobile · Web3 search · Tor / proxy chains · client profiles ·
wallet Crypto and Address-book layers plus `CapabilityDescriptor` · cross-device sync ·
Windows and macOS packaging with code signing.

**Ideas, not scheduled: a BitTorrent streaming app, and Nostr identity.** A torrent app would be
compatibility tier 4 (`architecture/app-compatibility.md`): a magnet link playing in a tab over
real TCP, DHT and peer exchange. `ADR-0001` makes the case for it, and
[`planning/torrent-app.md`](planning/torrent-app.md) keeps what is already known about building
one. Nostr identity is `window.nostr` (NIP-07) backed by `orivon.id`: one identity across every
Nostr client, with no extension. `src/nostr/` holds the protocol code, and nothing wires it into
a page.

**Native desktop apps rendered in a tab, via Linux containers.** Parked, not scheduled, and
analysed in [`planning/container-apps-opportunity.md`](planning/container-apps-opportunity.md).
It would make compatibility tier 3 cost an image build rather than a rewrite. Read that document
before re-deriving the estimate: the standalone figure that made it look too expensive was
mostly permission machinery the broker already builds.

## UNRELATED to the MVP

DAO and tokenomics · advertising and featured placement · governance · community growth
systems · merit tracking. These are organisational, not product, and none moves the metric.

---

## Explicit non-goals

State these publicly. They prevent both scope creep and disappointed users.

- **Not a wallet.** No funds, no seed phrase, no send/receive.
- **Not an app store.** Developer mode, not a marketplace.
- **No judged score passed off as a machine-verified one.** The indicator keeps what the machine
  observed apart from what a provider attests, names the provider behind every judged level, and
  shows a bundle no provider has assessed as grey `?`. Blurring the two would be exactly the
  dishonesty the indicator exists to prevent.
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

Every app this build runs, the ported Node.js apps included, uses only the public capability
API, with no privileged shortcuts and no special-casing in the shell. They are the API's
consumers and its validation suite.

Measurable claim: a port costs a recipe, a manifest and one bridge file, each port costs less
than the ones before it, and none needs a change in this repository that only it uses. A gap a
port finds is fixed here for every app, never for that one.

The e2e fixture app is the smallest consumer: a minimal app served over HTTP with a real
manifest, built only against the public API, exercising `orivon.net` and `orivon.fs` through the
shim. It doubles as the developer-mode example for journey 4 and the docs. Record hours per port
and per build step: "cost" needs a unit, and nobody reconstructs their own hours afterwards.

## What would count as failure

Worth agreeing in advance, so the result is interpretable either way:

- The week-0 spike fails **and** the `utilityProcess` fallback also underperforms → the
  capability model does not carry real workloads.
- The journeys are built and shown to the right communities and produce no organic traction →
  the daily-use hypothesis is wrong.
  *(This needs a named distribution asset (A249), a named community list, a window and a number
  before it can fire. Without them it is unfalsifiable: any outcome supports "wrong community,
  try another".)*
- Ports stop getting cheaper, or keep needing changes here that only one app uses → the API is
  not generic; it is a set of per-app adapters.
