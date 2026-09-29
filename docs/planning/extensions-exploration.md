# Extensions: exploration and recommended path

> **Draft, 2026-09-28.** Written for the owner, who has the decisions in section 10 to take, and
> for the agent that would build extension support. Nothing here is built. `docs/planning/` is
> exempt from CLAUDE.md Rule 2, so dates and reasoning stay here; the live pages named in
> section 12 must be rewritten to state only what is true once the work lands.

**The ask** (owner, 2026-09-28):

1. An extension can act on every page, whether it is a Web2 site or a Web3 site.
2. By default it gets only the ordinary web stack, **even on a Web3 site**: the DOM, its own
   `chrome.*` APIs, the network. No `window.orivon`.
3. Reaching `window.orivon`, including interfering with it, takes a specific permission that each
   extension declares and the person accepts.
4. Installing an extension is the person's own risk.

**The answer in one paragraph.** Electron 44 loads ordinary Chrome extensions and runs their
content scripts and service workers; the toolbar button, the popup and network blocking all need
work from Orivon, and network blocking is dead today on both of its APIs (section 6). Every
measurement below comes from a probe run against Electron 44. Requirement 2 holds for
everything Orivon *hands* an extension: its content scripts, its service worker and its own pages
can be kept free of `window.orivon`. It does **not** hold against an extension that deliberately
runs code in a page's main world. Three routes do that, all three work on Electron 44, and one
works through a strict page CSP. Code that gets there calls `window.orivon` as the page, with the
page's grants: the position `ADR-0021` already takes for any third-party script in a page. So
the `orivon` permission can be a consent boundary and a policy boundary, but it cannot be a
sandbox, unless Orivon keeps extensions without it out of the sessions of origins that hold
grants. Electron's per-session loading makes that possible, and this document recommends it
(sections 4 and 6). And "interfering" cannot
mean patching `window.orivon`: it is locked, measured, for everyone. The only place interference
can be offered, and the only place it can be enforced, is the broker.

---

## 1. What was measured

A throwaway Electron app in the shape of Orivon: a session preload exposing a stand-in `orivon`
through `contextBridge`, a `webPreferences` preload, a service-worker preload, and three test
extensions (MV3, MV2, and one with unknown manifest keys). Source and raw output:
`docs/planning/spike-results/extension-probe/` and `extension-probe.json`. Electron 44.0.0,
Chromium 152.0.7977.54, Linux, run headless through `scripts/run-headless.mjs`.

| Question | Result |
|---|---|
| Does an isolated-world content script see `window.orivon`? | **No** (`undefined`), on every page |
| Does a `"world": "MAIN"` content script see it, at `document_start`? | **Yes**, already present, and a call to it runs with the page's `location` |
| Does `chrome.scripting.executeScript({ world: 'MAIN' })` from the service worker reach it? | **Yes** |
| Does an inline `<script>` added by the content script reach it? | **No**: MV3's isolated-world CSP refuses inline script, even on a page with no CSP |
| Does a web-accessible `<script src="chrome-extension://...">` reach it? | **Yes**, including on a page whose CSP is `script-src 'self'` |
| Can main-world code replace, wrap or redefine `window.orivon`? | **No**: `writable: false`, `configurable: false`, object frozen. Assignment fails silently, `defineProperty` throws |
| Does a content script run on `http://probe.eth` (a `.eth`-shaped host)? | Yes. `https://name.eth` and `https://<cid>.ipfs.orivon` are plain https to Chromium, so `<all_urls>` covers them |
| Does a content script run on a custom scheme (`probe3://`, standard and secure)? | **No**, not even with `<all_urls>` |
| Does a session `frame` preload reach the extension's own page (`chrome-extension://<id>/page.html`)? | **Yes**. So does a `webPreferences` preload on a view that navigates there |
| Does a session `service-worker` preload reach the extension's service worker? | **Yes**: an object exposed by it is visible to the extension's `bg.js` |
| Is `window.orivon` visible to the service worker otherwise? | No |
| Is an extension loaded into one session active in another? | No: loading is per session |
| Can an extension load into an in-memory session? | **No**: "Extensions cannot be loaded in a temporary session" |
| Does MV2 still load? | Yes, with a deprecation warning, and its content script runs |
| An unknown permission (`"orivon"`) and an unknown top-level key (`"orivon": {...}`)? | Both load. The permission logs "Permission 'orivon' is unknown"; the key is kept in `Extension.manifest`, so Orivon can read it |
| `chrome.*` namespaces present in the MV3 service worker (permissions `scripting`, `storage`) | `dom, extension, i18n, management, runtime, scripting, storage, tabs` |

A second probe tested network rules (`spike-results/extension-network-probe/` and
`extension-network-probe.json`). Each case loads one page that carries a CSP (`connect-src 'none'`)
and a script `blocked.js`; the extension tries to strip the CSP and block the script. The
embedder's hook was registered before the extension loaded; that order was not varied.

| Case | Extension's rules take effect? |
|---|---|
| MV3 `declarativeNetRequest`, static rules, any session | **No**, not even a plain block rule. The extension loads without a warning and does nothing |
| MV2 blocking `chrome.webRequest`, session with no embedder `webRequest` listener | Yes: script blocked, CSP stripped |
| MV2 blocking `chrome.webRequest`, session where the embedder has **any** `session.webRequest` listener, even one filtered to `https://*.eth/*` on a different event | **No**: the extension's listeners are silenced for every URL |
| Any extension holding `webRequest` or `declarativeNetRequest`, in a session serving https through `protocol.handle` | **The handler is bypassed**: the request goes to the network (`ERR_NAME_NOT_RESOLVED` here). A content-script-only extension leaves the handler working |

The last row is the dangerous one. On an app partition, where the pinned cache is served through
`protocol.handle('https')`, loading an ad blocker would make the page load from the live network
instead of the pin: T21 failing open.

Not measured yet (section 11): real extensions (an ad blocker, a password manager, a dark-mode
extension) end to end; subframes; MV3 `webRequest` with `webRequestBlocking`.

## 2. Where the repository stands

- **No extension code.** Nothing calls `session.extensions`, nothing passes `--disable-extensions`.
  The toolbar already reserves a disabled button, "Extensions: not in v0"
  (`src/renderer/index.html:111`). `chrome-extension` is on the never-external scheme list
  (`src/main/sessions/external-links.ts:27`).
- **`window.orivon` is on every ordinary tab**, not only on app tabs: `src/preload/app.ts` calls
  `exposeOrivon()` unconditionally, and `src/preload/README.md` says so. Only the routed network
  path and the Node shim globals are app-tab-only (`--orivon-app-tab`). The property is locked
  (`src/preload/surface/main-world-socket.ts:476`, `ADR-0021`). **Contradiction to file:**
  `security-model.md` T4 says the ordinary-tab preload "exposes `window.nostr` only and does not
  reference `orivon.*` at all"; the code does the opposite, and `window.nostr` is not wired.
- **The broker knows a caller by its frame's origin and nothing finer**
  (`src/broker/transport/ipc.ts:182`, `src/broker/policy/origin.ts:203-278`). Two scripts in one
  page are indistinguishable to it, which is why main-world reach equals the page's grants.
- **Sessions.** The default session holds the chrome view, the dashboard, the permission popups
  and every ordinary Web2 tab. Each origin that holds grants or is served from cache gets
  `persist:app-<sha256>` (`src/main/shell/tab-view.ts:39-44`), and a navigation re-partitions the
  tab (`ADR-0018`). Web contexts are in-memory `web-context-*` partitions; embeds have their own.
- **Web3 content is https to Chromium.** `.eth` is `https://name.eth` through the verifier's
  loopback host; IPFS is `https://<cid>.ipfs.orivon` with `ipfs://` shown in the address bar;
  cached apps are served by `protocol.handle('https')` on their partition, with a CSP built from
  grants (`src/loader/serve/csp.ts`). So content scripts reach all of it; nothing Web3 sits on a
  custom scheme that would hide it.
- **Orivon already hooks sessions** where extensions would also hook: `webRequest` listeners on the
  default session (the verifier, `https://*.eth` and `*.ipfs.orivon`), on app partitions
  (`onHeadersReceived` for the T22 CSP), on embed and web-context sessions; `protocol.handle` on
  app partitions and web contexts; permission handlers and `setCertificateVerifyProc` on every
  session. `src/main/verifier/README.md` already warns that a `webRequest` listener on a session
  whose https goes through `protocol.handle` breaks routed redirects.
- **Consent can only name an origin.** It is a native dialog, and `ConsentPrompt` is
  `(origin, capability, patterns)` (`src/main/consent/request-grant.ts:34`).
- **Tabs** are `WebContentsView`s held by one `TabManager` per window, with `createTab`,
  `activeWebContents`, `findTabIdByWebContents` and `onStateChange`
  (`src/main/shell/tabs.ts`). There is no registry across windows.
- **Scope.** Extensions appear nowhere in `docs/scope.md`. The intro screen's "No extensions
  needed" is about Web3 needing no wallet extension, and stays true.

## 3. Three ways to build it

**What Electron gives, and what it leaves out.** Electron calls Chrome-extension compatibility a
non-goal and supports a subset. Fully: `scripting`, `webRequest` (but see section 1: any
embedder listener silences it), `devtools.*`. Partly: `runtime`, `storage` (`local` only),
`tabs` (`sendMessage`, `reload`, a partial `query`/`update`), `management`, `extension`, `i18n`.
`chrome.action` exists but every method is a stub that logs "not supported in Electron", so no
toolbar button or popup works without the embedder's help. `contextMenus`, `cookies`,
`notifications` and `sidePanel` are accepted as permissions and not implemented. Nothing is
remembered between runs, packed `.crx` files do not load, and there is no JavaScript hook to veto
an injection.

- **A. Chrome extensions as they are**, on Electron's support, plus the missing APIs.
  `electron-chrome-extensions` (Samuel Maddock) adds `action`, `tabs` (create, remove, query),
  `windows`, `contextMenus`, `cookies`, `notifications`, `webNavigation` and a `<browser-action-list>`
  toolbar element; the host passes callbacks (`createTab`, `selectTab`, `removeTab`, ...) and
  registers each tab. Its licence is GPL-3.0 (or a paid licence), which Orivon's AGPL-3.0-only can
  combine with; it has no native addon; its last npm release is from 2025-07, though the
  repository tracks Electron 44. **It also spawns native-messaging hosts with
  `child_process.spawn`**, reading Chrome's host manifests from the machine. That is native code
  outside the broker, which Orivon does not allow: the path must be disabled, and if the library
  cannot do that without a fork, the fork is the reason written down (Rule 6).
- **B. An Orivon-native extension format.** An Orivon manifest, content scripts that Orivon's own
  preload injects into an isolated world, capabilities through `orivon.*`. Orivon controls
  everything, the permission model is native, and it works in every partition because it does not
  depend on Chromium's extension system. It has no ecosystem: no ad blocker, no password manager,
  nothing a person arriving from another browser already uses. It answers no need that exists today.
- **C. A, plus an `orivon` manifest key** that Orivon reads and Chromium ignores (section 5).
  Extensions written for Chrome work unchanged at the ordinary web stack; an extension that wants
  Orivon declares it in the same manifest.

**Recommendation: C.** It is the only option where the first extension a person installs is one
they already use, and the only part Orivon invents is the part that is Orivon's. On the library:
use `electron-chrome-extensions` if native messaging can be switched off cleanly, and otherwise
write `action`, `tabs` and `windows` over `TabManager` (about the size of the library's own tab
code). A user-scripts-only design (a script manager and nothing else) is smaller still, but it
serves no extension anyone already has.

## 4. What "access to `window.orivon`" can mean, and what can be enforced

The owner's words cover three different things, and they separate cleanly:

- **Use as itself.** The extension calls `orivon.*` as its own principal, `chrome-extension://<id>`,
  from its service worker or its own pages. It holds its own grants, asked for and granted like
  any origin's (grants attach to the origin). Nothing about any page is involved.
- **Act as the page.** Extension code calls the page's `window.orivon`, with the page's grants.
- **Interfere.** The extension sees, blocks or changes what pages do with `orivon.*`: a guard
  that inspects every signing request before the page's call goes through, a debugger that logs
  calls, a privacy tool that denies a capability on a site.

Where each surface stands:

| Surface | Without the permission | With it | Enforced by |
|---|---|---|---|
| Content script, isolated world | No `orivon` | No `orivon` (unchanged) | Chromium's world isolation, measured |
| Service worker | No `orivon` | Own `orivon`, as the extension's principal | A `service-worker` session preload that exposes it only when the manifest carries the permission (preload reach measured) |
| Extension pages (popup, options, side panel) | **The object appears** when a page opens in a tab, since a tab's preload reaches `chrome-extension:` pages (measured). Every call is refused: the broker accepts only `http:` and `https:` origins (`src/broker/policy/origin.ts:18`) | Own `orivon`, as the extension's principal | The preload stops exposing on `chrome-extension:` without the permission; the broker admits `chrome-extension:` only for an extension that holds it |
| Page main world (MAIN content scripts, `chrome.scripting` MAIN, web-accessible `<script>`) | **Calls the page's `orivon` with the page's grants** | Same | **Nothing in the page.** See below |
| Interference | None possible: `window.orivon` is locked | A broker hook | The broker, which sees every call |

**The residual, stated plainly.** Any extension with host access to a page can put code in that
page's main world, and that code is indistinguishable from the page's own. This is the same fact
as "an extension with access to your bank can move your money" in every Chromium browser, and
`ADR-0021` already accepts it for third-party scripts inside an app. Blocking the three measured
routes one by one is a losing game: `"world": "MAIN"` is how ad blockers run their scriptlets, so
refusing it breaks the extensions people most want, and a rewrite of `chrome.scripting` in the
service worker does not cover the same API called from an extension page.

Three ways to handle it, cheapest first:

- **N1, disclose.** The install prompt says what Chromium browsers say, plus the Web3 part: "can
  read and change every site you visit, **and use the Orivon permissions you have given those
  sites**". Chrome parity, no enforcement.
- **N2, disclose where it matters.** N1, plus: the broker knows which extensions have host access
  to the tab's origin (from their manifests and the person's per-site choices), so a grant prompt
  on that origin can name them ("Extensions X and Y can also use what you grant here"), and the
  site-info popup can list them next to the site's grants. Cheap, honest, still no enforcement.
- **N3, keep grant-holding origins out of reach.** Load an extension without the permission into
  the default session only, never into a `persist:app-*` partition. Every origin that holds a grant
  lives in such a partition, so an extension without the permission never runs where a grant
  exists: it still acts on every Web2 page and every Web3 page that has been granted nothing, and
  on an ungranted page `window.orivon` can only raise a prompt, never exercise a grant. This is
  real enforcement, and it costs requirement 1 on granted origins, where an ad blocker would not
  run. A per-site switch ("allow on this site") could load a chosen extension into one app's
  partition, with the prompt saying what that means.

**Recommendation: N3 with N2's disclosure on top**, as decision D2. N3 is the only design in
which the permission is a wall, and it costs little extra: an extension with network rules must
stay out of app partitions anyway, because it turns off the pinned cache there (measured,
section 1). N2's disclosure still matters on ungranted pages and wherever the person opts an
extension into a granted site. If the owner prefers requirement 1 to hold everywhere, N2 alone
is the honest fallback, and it only works for content-script extensions (section 6).

**Prompt spoofing.** A main-world script can call `orivon.app.requestGrant` on a page whose
manifest declares a capability, and raise a consent prompt that names the *site*. N2's prompt
line covers it; a per-tab rate limit on prompts is cheap insurance.

**Wallet extensions** are the main-world case by design: MetaMask injects its provider with a
`world: "MAIN"` script at `document_start`. That is ordinary web stack, needs no `orivon`
permission, and fits the wallet exploration's plan: Orivon's own `window.ethereum` carries the
platform descriptor (`ADR-0021`), so an extension can take it over, and EIP-6963 lets both
announce themselves to a dapp.

## 5. The `orivon` permission: recommended shape

A top-level manifest key, which Chromium ignores and Orivon reads from `Extension.manifest`
(measured). A key rather than an entry in `permissions`, because Chromium warns about an unknown
permission on every load and a key is silent:

```json
"orivon": { "permissions": ["self", "hook"] }
```

- **`self`**: the extension gets `orivon` in its service worker and its own pages, as the principal
  `chrome-extension://<id>`. Each capability is still asked for and granted through the ordinary
  consent path, keyed on that origin, exactly as for a site. The extension id is stable for a given
  key, so grants survive updates the way a site's survive a redeploy.
- **`hook`**: the extension may register with the broker to observe, and optionally deny, calls
  made by pages. The hook runs in the broker (trusted), which calls the extension's service worker
  for each call matching a filter the extension registered (origin patterns and capability kinds),
  before executing it. Observe and deny are enough for a transaction guard or a per-site
  kill-switch; **modifying arguments or results** is a much larger grant (the extension could
  substitute a signing target) and is left as an owner decision.
- **Acting as the page is deliberately not a permission.** Main-world code already can (section 4),
  and an official path would only make the residual look endorsed. Anything an extension needs to
  do *with* a site's capabilities should be a `hook`, where the broker sees it and can name it.

**Consent.** At install: host access (Chromium's own wording) plus, when the key is present, one
line per Orivon permission. `hook` is the strong one and gets its own sentence ("can see and block
what sites do with your Orivon permissions"). At use: `self` capabilities prompt like any origin.
**On update**, a new Orivon permission, or a widened host pattern, re-prompts before the new
version runs, on the T19 rule (subset check, not kind comparison).

**What changes in `src/contracts/`.** `self` adds no methods: it is the same `orivon.*` surface
with a new kind of caller. It does change who can be a caller: `originFromUrl` admits only `http:` and
`https:` (`ORIGIN_BEARING_SCHEMES`), and a `chrome-extension:` origin is a new principal kind,
admitted only for an extension whose manifest carries `self`, that the consent prompt must render
as the extension's name and icon rather than as an origin string. `hook` is a new
contract (register, filter, decide, timeout) that only extensions see. Both are contracts changes:
an ADR each, and a contracts PR that goes alone and merges first.

## 6. Sessions: the constraint that decides the architecture

Electron loads an extension into one session at a time, refuses in-memory sessions, and keeps an
extension's service worker and `chrome.storage` per session (measured and documented). Orivon's
tabs live in several sessions:

| Session | Holds | Extension consequence |
|---|---|---|
| default | chrome view, dashboard, popups, every Web2 tab, ungranted Web3 pages | The natural home. **But the privileged views live here**: in development the chrome view loads from `http://localhost`, which `<all_urls>` matches. Move the privileged views to their own partition first |
| `persist:app-<sha256>` | one granted or cached origin each | Loading an extension here starts a **separate instance**: its own service worker, its own storage, its own login. A password manager would be logged out in every app. **An extension holding `webRequest` or `declarativeNetRequest` bypasses the pinned-cache handler** (section 1): never load one here |
| `web-context-*` (in-memory) | web contexts | Cannot host an extension at all |
| embed partitions | an app's embedded pages | Out of scope; nothing loads there |

So "every page" (requirement 1) collides with Orivon's per-origin partitions, and the collision
is structural, not a missing API. Options:

- **S1, everywhere.** Load every enabled extension into every persistent partition. Requirement 1
  holds; state is fragmented per app, memory grows with apps times extensions, N3 becomes
  impossible, and any network-rule extension turns the pinned cache off (measured). **Ruled out**
  unless that bypass is fixed first.
- **S2, default session only** (with N3's per-site switch as the exception). Extensions run on the
  open web and on ungranted Web3 pages as one instance each. Granted origins get none unless the
  person allows one there.
- **S3, default session, plus a stripped copy in app partitions.** A rewritten manifest (no MAIN
  content scripts, no `scripting`, no web-accessible resources, no `webRequest` or
  `declarativeNetRequest`) keeps extensions on granted origins at the ordinary web stack by
  construction. Two instances with split storage, and extensions that need what was stripped
  break there.

**Recommendation: S2.** It is the only option whose cost is visible and bounded, it gives N3 for
free, and it leaves a per-site opt-in rather than a default. The per-site opt-in may load only a
content-script extension (no network rules) into an app partition. S2 is also the option that
contradicts the owner's requirement 1 on granted origins, which is why it is decision D2.

### Blocking requests: what an ad blocker needs, and why none works today

Network blocking is the reason most people install an extension, and on Electron 44 in Orivon's
current shape it is dead on both paths: `declarativeNetRequest` is inert, and `chrome.webRequest`
is silenced in the default session by the verifier's partition stamp (`installPartitionStamp`
in `src/main/verifier/verifier-subsystem.ts`, a `webRequest.onBeforeSendHeaders` listener that
tells the verifier which partition a request came from). Content scripts, and cosmetic filtering
built on them, still work. Three ways out:

- **B1, free the default session's `webRequest`.** Move the partition stamp to a mechanism that is
  not a `webRequest` listener. Then MV2 blockers work in the default session. It does nothing
  for MV3 blockers, which are built on `declarativeNetRequest`, and MV2's future in Electron is
  borrowed time.
- **B2, implement `declarativeNetRequest` in Orivon.** Read an extension's static rule files from
  its folder, catch its dynamic and session rules through the `service-worker` preload, and apply
  them in Orivon's own `webRequest` listeners (Electron keeps one per event per session, so one
  module owns them all, the partition stamp included). This is what makes MV3 blockers work, and it keeps one owner of
  the session's `webRequest`. It is a real subsystem: the rule grammar, priorities, `allow` and
  `allowAllRequests`, `modifyHeaders`, redirect, and per-rule counters.
- **B3, a built-in blocker.** A mature pure-JS filter engine hooked into Orivon's `webRequest`
  listener (Rule 6), with extensions left to cosmetic filtering. `@ghostery/adblocker` (MPL-2.0,
  pure JavaScript dependencies, 2.18.2) is the obvious candidate, with an Electron adapter that
  would have to be folded into Orivon's one listener rather than registering its own.

Context for the choice: Chrome removed MV2 in version 139, and the Chrome Web Store pulled every
MV2 item on 2026-08-31, so classic uBlock Origin can no longer be fetched from there. Reports on
`declarativeNetRequest` in Electron conflict (dynamic rules said to work on Electron 43 when no
`session.webRequest` listener is present, static rule files said never to load); the probe
confirms the static half on 44.

**Recommendation: decide between B2 and B3 as a product question (D7), not an extension
question.** B3 is far cheaper and gives every person blocking on day one, but it makes Orivon
a browser with a built-in blocker, which is a scope row of its own. B2 keeps the choice with the
person and makes MV3 blockers work, at the cost of a subsystem. B1 alone is not worth doing.

## 7. Where extensions come from, and updates

Electron loads only unpacked folders and remembers nothing, so Orivon keeps its own registry of
installed extensions (id, source, version, the unpacked path, the person's per-site choices, and
the `orivon` permissions granted) and loads each one again at every start.

| Source | How | Trust | Recommendation |
|---|---|---|---|
| Unpacked folder | `loadExtension(path)` | The person's own | First, behind developer mode |
| `.crx` or `.zip` file | Unpack in pure JavaScript, then as above | CRX3 carries a signature Orivon can verify itself | Second |
| Chrome Web Store | `electron-chrome-web-store` (MIT, pure JavaScript): fetches from Google's update endpoint, auto-updates at start and every 5 hours | **It checks only that the id matches the key hash, not the signature**, so it relies on TLS alone; it presents itself to Google's endpoint as Chrome | Owner decision (D5). The store terms have no browser clause; section 3.3's "interface provided by Google" and "automated means" wording is the risk for a direct downloader. Brave, Vivaldi and Arc install from the store |
| Content-addressed (an IPFS CID, or an ENS name pointing at one) | Fetch through Orivon's verified IPFS path, check every block against the CID | The strongest of the four: the bytes are the ones the publisher named | Later: nobody publishes extensions this way yet, but it is the Web3-native story and reuses the DDOC machinery |

**Updates** re-prompt before the new version runs when host patterns widen or an `orivon`
permission is added, on the T19 subset rule. A content-addressed extension updates only when its
name points at a new CID, which is the same rule as a `.eth` app.

## 8. Components, and where they live

| Piece | Where | Label |
|---|---|---|
| Manifest policy: read the `orivon` key, host patterns, MAIN/`scripting`/web-accessible use; decide what the install prompt says and whether an update re-prompts | `src/broker/policy/extension-manifest.ts` (a pure function of the manifest) | durable |
| Extension principal in the grant ledger and consent | `src/broker/`, `src/main/consent/` | partly tied |
| Loader: unpack, verify, `session.extensions.loadExtension` per session, reload on boot (Electron does not remember extensions across runs) | `src/main/extensions/` | tied to Electron |
| `chrome.tabs`, `chrome.windows`, `chrome.action` bridge to `TabManager` | `src/main/extensions/`, or a library (section 3) | tied to Electron |
| Preload gating: no `orivon` on `chrome-extension:` without `self`; the service-worker preload for `self` | `src/preload/` | tied to Electron |
| Toolbar button, action popups, per-site access, the extensions page | `src/renderer/`, `src/main/permissions/popover-view.ts` pattern | tied to Electron |
| Hook dispatch | `src/broker/` | partly tied |
| One owner per session of each `webRequest` event (the partition stamp, the T22 CSP, and B2's rules if chosen), since Electron keeps one listener per event and any listener silences extensions' own | `src/main/sessions/` | tied to Electron |

## 9. Security model additions

New rows for `security-model.md`, in its shape:

- **An extension's main-world code acts as the page, with the page's grants.** Mitigation: N3
  keeps extensions without the permission out of grant-holding origins; N2's disclosure covers
  ungranted pages and per-site opt-ins. Stated, not solved, in the manner of `ADR-0021`.
- **An extension raises consent prompts in a site's name.** N2's prompt line, and a per-tab prompt
  rate limit.
- **Orivon's own preload reaches extension pages** (measured). Harmless today, since the broker
  refuses the origin; once `self` exists, the preload exposes nothing on `chrome-extension:`
  without it, and the broker checks the manifest on its own rather than trusting the preload.
- **An extension reaches the shell's privileged views** through the default session. They move to
  a partition of their own before any extension loads.
- **An extension changes a verified Web3 page after verification.** DDOC proves the bytes Orivon
  served, not what a content script did to the DOM afterwards, so the Web3 Score shield (T29)
  should say "changed by an extension" when a content script ran in the tab.
- **An extension turns off the pinned cache.** Measured: an extension holding `webRequest` or
  `declarativeNetRequest` in a session that serves https through `protocol.handle` sends the
  requests to the network instead (T21 failing open). The loader refuses to load such an
  extension into any partition with a `protocol.handle('https')`, and a test asserts it. In a
  session where Orivon itself holds a `webRequest` listener, an extension's `webRequest` cannot
  touch Orivon's headers (also measured); B2 must keep it that way by applying Orivon's own
  headers after the extension's rules.

## 10. Decisions for the owner

| ID | Decision | Recommendation |
|---|---|---|
| D1 | **The need** (Rule 4). Which extension, for which person, makes this worth building now? It is not in `docs/scope.md` | An ad blocker and a password manager are the two a person arriving from another browser expects first; naming one real person or metric line settles it |
| D2 | **Granted origins**: extensions run there by default (S1/N2), or only when the person allows a content-script extension per site (S2/N3). This is where the recommendation departs from requirement 1 | S2/N3: it makes the permission a real boundary, and network-rule extensions cannot run there safely anyway |
| D3 | **Permission split**: one `orivon` switch, or `self` and `hook` separately | Separately: `self` touches only the extension's own grants, `hook` touches every site's |
| D4 | **Hook power**: observe, observe and deny, or also modify | Observe and deny |
| D5 | **Install sources**: is the Chrome Web Store in, given a downloader that impersonates Chrome and checks no signature? | Unpacked and file first; the store only with Orivon's own CRX3 signature check added |
| D6 | **MV2**, which Electron 44 still loads and the store no longer serves | Load it from a folder or file, never promise it: it is on borrowed time in Electron too |
| D7 | **Ad blocking**: implement `declarativeNetRequest` (B2) or ship a built-in blocker (B3) | A product call. B3 if blocking should be on for everyone; B2 if it should stay the person's extension |
| D8 | **Native messaging** (extensions talking to desktop programs, which some password managers use) | Off. It is native code outside the broker |

## 11. Build order, and what to measure first

0. **Measure** (no product code), in the probe harness: three real extensions end to end (a
   password manager, a dark-mode extension, an MV3 blocker), since the reports on each conflict;
   dynamic `declarativeNetRequest` rules with and without an embedder `webRequest` listener; MV3
   `webRequest` events reaching a service worker; whether a `service-worker` session preload also
   runs in websites' service workers (it must check its scope if so); content scripts in
   subframes; whether `electron-chrome-extensions` can run with native messaging off.
1. **Prerequisites, invisible to the person**: the privileged views move out of the default
   session; Orivon's preload refuses `chrome-extension:`; the T4 contradiction is filed and fixed.
2. **Developer mode**: load an unpacked folder into the default session, enable the toolbar
   button, show action icons and popups. No `orivon` key yet; the key is rejected, not ignored.
3. **Installing for real**: the install prompt with N2's wording, per-site access, persistence
   across runs, updates.
4. **Granted origins**, per D2.
5. **The `orivon` key** (`self`, then `hook`): ADRs and a contracts PR first.

## 12. Records this work must produce

- `docs/scope.md`: an IN row when D1 is answered, stating what this build loads and what it does not.
- An ADR for the extension principal and the `orivon` manifest key; one for the session model (D2).
- `security-model.md`: the rows in section 9, and T4 rewritten to match the code.
- `ARCHITECTURE.md` §Where things live: `src/main/extensions/` (tied) and the manifest policy
  (durable).
- `docs/planning/compatibility-matrix.md`: a line for Chrome extensions, with what works.

## Sources

Measured here: `docs/planning/spike-results/extension-probe.json` and
`extension-network-probe.json`, with the probe apps beside them. Run one with
`env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs node_modules/electron/dist/electron <probe-dir> --user-data-dir=<scratch>`.

Repository: `src/preload/app.ts`, `src/preload/README.md`, `src/preload/surface/orivon.ts`,
`src/preload/surface/main-world-socket.ts`, `src/broker/transport/ipc.ts`,
`src/broker/policy/origin.ts`, `src/main/shell/tab-view.ts`, `src/main/shell/tabs.ts`,
`src/main/verifier/verifier-subsystem.ts` and its README, `src/main/install/granted-origin-csp.ts`,
`src/loader/serve/csp.ts`, `src/main/consent/`, `src/renderer/index.html`,
`docs/architecture/security-model.md` (T3, T4, T18, T19, T21, T22, T29), `ADR-0018`, `ADR-0021`.

External, read 2026-09-28:

- Electron: [Chrome extension support](https://www.electronjs.org/docs/latest/api/extensions),
  [`Extensions` API](https://www.electronjs.org/docs/latest/api/extensions-api),
  [context bridge](https://github.com/electron/electron/blob/main/docs/api/context-bridge.md),
  [`chrome.action` stub](https://github.com/electron/electron/blob/main/shell/browser/extensions/api/extension_action/extension_action_api.cc),
  [service-worker preloads, PR #44411](https://github.com/electron/electron/pull/44411),
  [extensions on custom schemes, `allowExtensions`](https://github.com/electron/electron/blob/main/docs/api/structures/custom-scheme.md),
  [webRequest and declarativeNetRequest reports, #52265](https://github.com/electron/electron/issues/52265),
  [Electron 44 release](https://www.electronjs.org/blog/electron-44-0).
- [`electron-chrome-extensions` and `electron-chrome-web-store`](https://github.com/samuelmaddock/electron-browser-shell),
  with its [issue #172](https://github.com/samuelmaddock/electron-browser-shell/issues/172) on
  which extensions work.
- Chromium: [content scripts and worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
  [`chrome.scripting`](https://developer.chrome.com/docs/extensions/reference/api/scripting),
  [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts),
  [MV3 content-script CSP](https://github.com/chromium/chromium/blob/main/extensions/common/manifest_handlers/csp_info.cc),
  [MV2 timeline](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline).
- [Chrome Web Store terms](https://ssl.gstatic.com/chrome/webstore/intl/en-US/gallery_tos.html);
  [Brave's deviations from Chromium](https://github.com/brave/brave-browser/wiki/Deviations-from-Chromium-(features-we-disable-or-remove)).
- [MetaMask's MV3 manifest](https://github.com/MetaMask/metamask-extension/blob/main/app/manifest/v3/_base.json)
  (a `world: "MAIN"` script at `document_start`); [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963).
- `@ghostery/adblocker` on npm (MPL-2.0).
