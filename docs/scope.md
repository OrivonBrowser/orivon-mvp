# Scope

> **Draft.**
> The long-term vision lives in `orivon-docs` and in the OrivonBook drafts
> (`docs/inventory.md` §1b). This document says which parts of it Orivon Browser has in this
> version; the rest lands one feature at a time, as a need calls for each.

## What Orivon Browser proves first

That a browser can run applications which are impossible in Chrome, reaching the network and
the filesystem directly under user-granted, per-app capabilities, while those applications are
ordinary web frontends delivered from a URL.

Everything else in Orivon's vision is downstream of that being true.

## Success metric

**100 active users in EU/USA, where active = 25 hours/month of `activeSec`.**

That is ~50 min/day of *actual use*, i.e. daily-driver usage. This metric, not the long-term
vision, decides what comes first.

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

If these work, this version has done its job. None of them is yet named as the distribution asset
(`open-questions.md` A249).

---

## IN: essential to the core thesis

| Item | Why it is essential |
|---|---|
| Shell: tabs, omnibox, back/forward | It has to be a browser, or the thesis is untested |
| **Settings** (`orivon://settings`): every implemented feature has its controls in one place, with search, a link to each section, and changes that apply at once | A person can only trust what they can see and change. Each feature that lands adds its section here |
| **Keyboard shortcuts, a main menu, zoom per site, history and developer tools** | What a person expects of a browser they live in. Shortcuts are remappable, zoom is remembered per site, history is kept locally and can be cleared, and F12 opens developer tools on any page, asking once before it does on an app that holds permissions |
| **Movable tabs, split view, profiles and private windows** | Tabs reorder, move between windows and tear off; two tabs show side by side; a profile is a separate browser; a private window starts empty and is deleted when closed. `ADR-0042` |
| **Tab state and recovery**: pinned, muted and audible tabs, duplicate, reopening a closed tab or window, tab search, and a card for a page that crashed or stopped answering | The success metric counts people who spend 25 hours a month in the browser, and they keep many tabs, close some by mistake and lose some to crashes. What is kept for reopening is addresses and titles, in memory, and a private session writes nothing |
| **Tab groups and sleeping tabs**: named, coloured, collapsible groups that survive a restart, and tabs that sleep when idle (Settings > Performance) and wake where they were | The people the success metric counts keep dozens of tabs open for hours. Groups keep them sorted; sleeping keeps the browser from using the memory they would otherwise hold. Sound, pinned, typed-in and prompt-waiting tabs and every app stay awake |
| **Reader view and a side panel**: an article in its own tab with the person's font, size, width and colours and read aloud with the system's voices; a panel beside the page for bookmarks, history and downloads | Long reading and looking something up while a page stays in view are daily use, and a browser without them sends people to another one. The article reaches the reader as a validated model of text, never as markup, and the panel has one slot for an extension's view |
| **Keyboard access**: F6 through the address bar, toolbar, tabs, bookmarks bar, side panel and page, arrow keys inside the toolbar and the strip, a focus ring on every control, and caret browsing | A person who cannot or will not use a mouse has to reach every control, and a page has to be navigable with a text cursor. Caret browsing asks first, since F7 is easy to press by mistake |
| **Start-up and window placement**: the new tab page by default, or where the last session ended, or chosen pages; an offer to restore after a crash; a Home button and page; the window opening where it was; `--orivon-kiosk` | A browser that forgets its windows is not one to live in. Every choice is in Settings (On start-up); the command line's addresses always open in front; a kiosk is one full-screen page that can only be left by quitting |
| **Page tools**: find in page, Stop, print and Save as PDF, Save page as, View page source, screenshots, Picture in picture, and right-click menus for links, images, media, selections and text fields, with spelling | What a person does with a page in front of them, every day. Each writes only where the person picks in a native dialog, and a toast says what happened. A PDF opens in Chromium's own viewer in a tab |
| **Address bar**: search with DuckDuckGo by default or any of a short list or the person's own https address, keywords for site search, suggestions from history, bookmarks and open tabs, addresses shown without `https://` and `www.`, a "Not secure" mark for plain http, and a QR code for the page | Non-address input needs *some* resolution or the omnibox rejects plain text outright, and a person who lives in the browser expects the bar to finish what they type. Known limitation, stated in-product: search text leaves the machine (`README.md` §Known limitations of v0); the engine's own suggestions as you type are a setting, off by default and never used in a private window |
| **Capability broker**: manifest, grants, per-origin enforcement | This *is* the product. `ADR-0002` |
| **`orivon-node-shim`** | Load-bearing: without it a Node.js app cannot run from a URL. It carries a Node web server's stack too: `http.createServer` under real `express` and `socket.io`, `fs.watch`, a run-time CommonJS `require`, and an esbuild plugin a port bundles with. `ADR-0005` |
| URL-addressed app fetch + cache + integrity check | The "apps are URLs" claim. `ADR-0005` |
| **DDOC**: a site publishes its bundle hash tree, the Web3 Score page shows whether the pinned bundle matches it, and a `.eth` name anchors the tree's root in its ENS record | The publisher's own statement of which bundle it ships, which a Web3 Score provider can attest to; the evidence behind site L2. Automatic, shown as evidence, and never blocking a load. The same-host tree is built with the app loader (build step 4). The ENS anchor, which catches a host compromised well enough to rewrite both its files and its tree, arrives with build step 6. `ADR-0029` |
| **UDP sockets** (`net.udpBind`) | DHTs, peer exchange and most P2P protocols need real UDP, not just TCP, and a web page can open neither. Part of what makes an app impossible in Chrome |
| **Node.js apps, ported**: existing Node.js and Electron desktop apps running from a URL over `orivon.*` | The platform's test cases, and journey 1. A real app finds the gaps a fixture never will. An app qualifies by running in the Node environment, WebAssembly components included, not by being JavaScript (`ADR-0036`). Ported in `orivon-ports`, never forked; nothing in this repository depends on that checkout (`ADR-0020`) |
| **ENS names and IPFS delivery, trust-minimised** | A `.eth` name resolved by a light client that proves the name's record, and IPFS content verified block by block against its CID, so a server supplies availability and never correctness. Reaches Delivery Level 2 (the canonical Connection-to-network scale's proven-name rung) and DDOC's ENS anchor. A `<name>.eth.limo` or `<name>.eth.link` address opened in a tab opens as the `.eth` name, so the name is checked here and not by the gateway; one setting turns it off. Journey 3 |
| **`ipfs://` and `ipns://` addresses** | Typed or linked, each shown as itself in the address bar and every consent surface, and served over HTTPS by the same verifier, every block checked. Added at the owner's request after build step 6, not in the original scope pass, with the protocol registry that makes the next protocol an isolated piece of work. A protocol may word a loading screen the tab shows while its page loads, and `ipfs://` does. `ADR-0038` |
| Identity seed in the OS keyring; `orivon.secrets`, an app's own origin-bound encrypted secret | `orivon.id` cannot survive a restart without the first half. Owner-requested; needed by two ported apps' own hand-off items (Element's pickle key, AirGap Vault's non-keyring fallback). `ADR-0033` |
| **App updates at a name**: an installed app at an ENS, DNSLink or IPNS name keeps running its version until the person accepts a newer one, asked when a provider has evaluated it, told why not otherwise | Apps ported to a name must reach people who installed an earlier build: without it every release is a new origin with no grants or data, or a silent swap of the code a person agreed to. The 100-active-users metric needs the same person to come back to the same app. `ADR-0056` |
| Per-app storage isolation + disk usage UI | Every app that writes to disk needs both. `ADR-0003` |
| **Trust indicator: the full spectrum, observed and judged** | Delivery ladder (incl. hash-pinning/TOFU), connection ladder and operations, automatic from observed behaviour. Judged levels (site L3 and L4, a site's operations and connections) come from the Web3 Score provider in Settings (the official one until the person changes or clears it), any address Orivon opens, asked by hash bucket so it never learns the site; it need not be trustless. Every judged level names its provider, is shown apart from what the machine observed, and never removes a grant warning. Providers are static sites built with web3-score-manager. `ADR-0006`, `ADR-0054` |
| **Per-site permissions and content settings**: a prompt under the address bar for the camera, microphone, location, clipboard, MIDI, idle detection, window placement and notifications; a popover off the address pill, a Settings > Site settings page, a pop-up blocker, and JavaScript, images, sound and automatic downloads per site | A browser that gives every page the camera, or none of them, is unusable for a call or a QR scan; a person can only trust what they can see and change per site. A registered app keeps its manifest's grants and is never asked. `ADR-0049`, `ADR-0032` |
| **Screen sharing**: a page asks with `getDisplayMedia` and the person picks a tab, a window or the entire screen in a picker in the page's window, with the tab's audio (and system audio on Windows); the page's tab and the shared tab say so, a bar in the window offers Stop sharing, and a site can be blocked | Calls and meetings are why people keep a browser open all day, and a ported chat app shares its screen the same way. Every share is chosen in the picker, never remembered, and only the call Orivon makes after the pick is granted. A registered app declares `media.screen`. `ADR-0055` |
| Developer mode: unpacked loader + docs | Permissionless is a core value, and it recruits the A+ developers. `ADR-0002` |
| Telemetry with time by site class and per Web3 or Web2.5 site, one identity per machine, a first-run active choice, a Settings switch, a privacy notice, and erasure | Without it the metric is unfalsifiable; the choice and the notice are not optional. `ADR-0004`, `ADR-0063` |
| **Packages for Linux, Windows and macOS on every GitHub release**: deb + AppImage, an NSIS installer, a dmg each for Apple silicon and Intel | A person should not need git and Node to try a browser. CI builds each package on its own system, launches it, and attaches it to the release. No certificate is bought: Windows warns once (SmartScreen) and macOS asks once (ad-hoc signature, Gatekeeper) |
| **Run-from-source on Windows and macOS** | `npm install && npm start` needs no installer trust at all, widens the audience, and self-selects contributors. Forces a no-native-modules policy on Orivon's own dependencies, not on the apps it runs |
| **Bookmarks**: star a page and edit it in a bubble, folders on a bar with a menu for each, a manager at `orivon://bookmarks`, bookmark all tabs, and import and export as an HTML file | A browser with no way to keep and arrange pages is not a plausible daily driver, since `activeSec` is what the success metric actually measures. One JSON file in the profile (`ADR-0003`) |
| **Downloads**: a list at `orivon://downloads` and a toolbar button with a bubble, files saved to the Downloads folder or a chosen one, pause, resume, cancel and retry, and a hold on files that run code until the person keeps them | A person who lives in the browser downloads files every day and has to find, resume and trust them; Orivon never opens a file that runs code. Files save with no prompt unless Settings says to ask |
| **A History page to live in**: by day or by session, sorted by recency, visits or name, site icons, selecting and deleting many, and the tabs closed recently | History is only useful if a person can find the page they meant; it stays local and is cleared from Settings or the page |
| **Import from another browser**: bookmarks and history from Chrome, Chromium, Edge, Brave and Firefox on this computer, and bookmarks from an HTML file | The people the success metric counts arrive from another browser with years of bookmarks. No profile's passwords are read; a CSV file imports at Settings > Passwords. A private window refuses the import |
| **Passwords**: a local store (`orivon://settings/passwords`) that offers to save after a sign-in that worked, fills the account the person picks, makes strong passwords for sign-up forms, and imports and exports CSV | The people the success metric counts leave a browser with their logins. Each password is encrypted by the system keyring, there is no store without one, and nothing fills a form by itself. `ADR-0050` |
| **Privacy controls**: block third-party cookies, Do Not Track and Global Privacy Control, always use secure connections, secure DNS, a certificate viewer, a sign-in sheet for HTTP authentication and a client-certificate chooser, a cookie list per site, and Clear browsing data from a shortcut | What a person expects of a browser they hand their browsing to. Each is a Settings control, and Global Privacy Control is on until the person turns it off; the cookie rule covers headers only, and frames' `document.cookie` is not covered |
| **Orivon and the operating system**: it registers as the default browser from an installed package, or from a Linux run from source with its own entry (Settings > Default browser, a box on the welcome screen, and a question a week after the last), opens links other programs hand it (a second launch, and macOS `open-url`), starts a window or a private session from the dock, the taskbar or the installed entry's menu, Share copies or emails a page's link, Create shortcut writes a desktop entry or link, and a new release links to its page | Links from mail and chat reach a browser only once it is the one the system knows, and a site people live in wants a launcher. Nothing is downloaded or installed by Orivon. The Windows and macOS parts are written and never built (`ADR-0057`) |
| **Files from this computer**: a path or `file:` address typed in the bar, Open file (`Ctrl+O`), a command line or Open with opens an HTML, XHTML, SVG or PDF file (a drop on a page and the macOS open-file event are provisional, A399 and A397), a picture, text or a folder in a tab of its own; a file that links a manifest asks once per run, in a warning whose Allow needs two presses, before it may use `window.orivon` | People keep pages and documents on disk, and an app shipped as a file should run without a server. Each file is an origin of its exact path in a persistent session that reads no other file (`ADR-0060`), and the packages claim the document types |
| **About and a task manager**: `orivon://about` with the version and graphics, and `orivon://tasks` with each process's memory and processor use and a way to end a tab that hangs | What a person reports a bug with, and the way out of a tab that stops answering. Typed `about:` and `chrome://` names open the page of the same purpose |
| Real tab favicons | A fix-round follow-on to the chrome restyle. Known limitation, same shape as the DuckDuckGo search row above: fetching a visited site's favicon is main-process network egress to whatever host serves that icon (`src/main/browsing/favicon.ts`), capped and re-encoded to a `data:` URL specifically so the privileged chrome view itself never makes the request |
| **A site shown inside an app's own page** (`web.embed`, Electron's `<webview>`), with the app's own script running first in every page it shows | Electron apps put a browser view inside their own window all the time, and a ported one meets an inert element otherwise. One warning-level grant; the shown pages run apart from the app and from ordinary browsing. An app that speaks a protocol of its own serves those pages from its own loopback listener and shows each at an origin of its own, and hears of a shown page's new window or download. `ADR-0039`, `ADR-0047` |
| **WASI programs in an app's tab**, and native modules and child processes as WebAssembly | Ported Node and Electron apps use native addons, `spawn` and `fork`, and each must keep every broker guard with no added risk, which only WebAssembly meets. Built: a WASI preview1 host over `orivon.fs`, Node's `wasi` module, and `child_process`, whose `spawn` runs a WASI program, or a WASI 0.2 component whose sockets reach `orivon.net`, and `fork` an app module, each in a Web Worker. A native addon loads as its WebAssembly build through `process.dlopen` or `module.createRequire`, and reaches files from a forked child of a cross-origin isolated app. `worker_threads.Worker` runs a thread the same way, and a forked child or thread of an isolated app has every synchronous `fs` call and `spawnSync`. An app's children live in a hidden host of its own until its last page closes (`ADR-0046`). A program that starts threads runs once its port makes it single-threaded, and an addon that runs a network node runs that node as a spawned component; a threaded addon build through `process.dlopen`, links and file times, and a Go program's own networking are not built. Native machine code never runs for an app. `ADR-0040` |
| **Chrome extensions**, MV3 and MV2, installed from a folder, a `.crx`/`.zip` file or the Chrome Web Store, one instance per profile on every website | People arriving from Chrome bring their extensions, and they are the people the success metric counts. This build runs an extension's content scripts, service worker, toolbar button, popup and own pages, and manages them at `orivon://extensions`, each with a details page. It runs on apps a person has granted permissions to (not on an app running from its pinned copy), and refuses their `window.orivon` calls from extension code (`ADR-0044`, `ADR-0045`); content blockers work, since Orivon applies their `declarativeNetRequest` rules and serves their `webRequest` listeners itself (`ADR-0051`, `ADR-0053`). Native messaging is off. `ADR-0043` |
| **Extension controls**: an Extensions button and menu with pinning, an extension's side panel (`chrome.sidePanel`), a sheet that asks for access an extension requests later, command keys with a page to rebind them, and `chrome.bookmarks`, `history`, `topSites` and `search` | A person with ten extensions needs to see which are on the toolbar, to say yes or no when one wants more, and to keep an extension's key from clashing with the browser's own. Nothing is granted silently, an extension never takes a key Orivon uses, and an app's pages stay out of its reach. The site-access picker, `activeTab`, an error log, page overrides and the extension side panel are not in this build, and each lands when a need calls for it (Rule 4) |
| **Cross-origin isolation on request** (`crossOriginIsolated` in the manifest) | A WebAssembly component built with threads needs `SharedArrayBuffer`, which Chromium turns on only for an isolated page. Opt-in, since isolation costs a page its popups' `window.opener`. `ADR-0036` |
| **New-tab dashboard**: a search box, every bookmark as a tile, and two inert shortcut tiles (Torrent, Nostr) | Replaces `about:blank`. Styled as a grid to match the long-term vision's layout (`orivon-docs`'s `dashboard-app.md`), but populated with only what is real today: no Wallet, Network or App-Store tiles, and no pluggable widget system underneath it, because that platform is the OUT row below, deliberately not pulled forward. The Torrent and Nostr tiles are honest placeholders (`disabled`, with a tooltip saying each is an idea not in this build), the same pattern already shipped for the toolbar's own not-yet-built icons. It sits on the welcome screen's mountain-meadow picture under a dark wash, in both colour schemes |
| **First-launch welcome screen**: a full-window page, "The browser Web3 deserves." and an "Enter Orivon" button, that opens over the dashboard | Shown once per profile by `npm start` and on every launch by `npm run dev` unless `--skip-intro` is passed (`ORIVON_INTRO`, `docs/development/setup.md`). It is a static page with no preload and no network access of its own, and a launch that cannot draw it skips it rather than leave the window covered. Clicking through reveals the dashboard. `d-0137`, `d-0138` |

## OUT: promised, not built yet

Real parts of Orivon, not in this version yet. Each lands when a need calls for it.

| Item | Why deferred |
|---|---|
| DDOC anchored in DNS (the vision's `DDOC <version> <hash>` record) | Scope: the ENS record is this build's off-host anchor. On ICANN domains without DNSSEC the record is forgeable anyway (`open-questions.md` C1). `ADR-0029` |
| Arweave, and content-addressed stores other than IPFS | IPFS is this build's second delivery path, and one proves the model |
| App store | Needs apps first. Developer mode covers the need until then |
| Dashboard **widget/extension platform**: installed apps placing their own widgets, an App Store, Wallet and Network widgets | Pure surface area; zero contribution to the metric. (The new-tab page itself, a grid with real bookmarks and two inert app shortcuts, shipped 2026-08-28 as an IN-table item above; this row is the pluggable platform underneath it, not the page) |
| Reading list | No app, person or measure has asked for it; the bookmark file keeps a root for it |
| Address autofill | No app, person or measure has asked for it; the browser has a password store and no address store |
| Device choosers | Per-device WebUSB and WebHID grants wait for an app or person that needs them; device permissions stay denied in this build |
| Funds-bearing wallet | Different security model entirely from per-origin identity |
| `hid` capability | No app here needs it yet, and a device capability is a large attack surface. `subprocess`, a native process for an app, is not deferred but excluded: a child process is a WebAssembly program in the app's tab (IN table above, `ADR-0040`) |
| Identity export / backup | First thing to add once identity has value to users |

## LATER: useful, further out

`orivon-runtime` (Wasmtime; arrives when untrusted third-party apps or mobile do) ·
mobile · Web3 search · Tor / proxy chains ·
wallet Crypto and Address-book layers plus `CapabilityDescriptor` · cross-device sync ·
Windows and macOS code signing with bought certificates (Developer ID with notarization, a Windows code-signing certificate).

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

## UNRELATED to the browser

DAO and tokenomics · advertising and featured placement · governance · community growth
systems · merit tracking. These are organisational, not product, and none moves the metric.

---

## Explicit non-goals

The wallet, app store, mobile, sync, containment and Bitcoin Core items bound this version, not
Orivon. State them publicly: they prevent disappointed users.

- **Not a wallet.** No funds, no seed phrase, no send/receive.
- **Not an app store.** Developer mode, not a marketplace.
- **No judged score passed off as a machine-verified one.** The indicator keeps what the machine
  observed apart from what a provider attests, names the provider behind every judged level, and
  shows a bundle no provider has assessed as grey `?`. Blurring the two would be exactly the
  dishonesty the indicator exists to prevent.
- **No mobile.**
- **No sync**, and no Orivon-operated server for user data. Infrastructure is limited to the
  telemetry ingest endpoint plus static hosting of first-party app bundles (e.g. GitHub
  Pages/Releases).
- **Untrusted apps are not contained.** Developer mode is genuinely "at your own risk"; a
  Node broker cannot sandbox hostile code. This is what `orivon-runtime` later fixes.
- **Bitcoin Core does not run in a tab.** That remains a long-term goal for the execution
  layer, not a claim of this version.

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
