# Extensions: build plan

> **Working plan, 2026-09-28.** The owner's answers to `extensions-exploration.md` §10 are
> below; this page turns them into packages of work. `docs/planning/` is exempt from CLAUDE.md
> Rule 2. Live pages are rewritten when each package lands (exploration §12).

## Owner decisions (2026-09-28)

| ID | Answer |
|---|---|
| D1 | The need is people arriving from Chrome with their extensions: "all newer extensions, even newer Chrome ones, should work" (success metric) |
| D2 | **Everywhere, one instance.** No split logins per Web3 app. On a granted app, code coming from an extension is refused by `window.orivon` unless that extension holds the Orivon permission |
| D3/D4 | `orivon` key with `self` and `hook`; hook may observe and deny, never modify |
| D5 | Unpacked folder, `.crx`/`.zip` file, and the Chrome Web Store with Orivon's own CRX3 check. **Who updates an extension is always shown in its information** |
| D6 | MV2 loads from a folder or file; never promised (exploration recommendation, not contested) |
| D7 | Reuse electron-browser-shell's libraries; do not reinvent |
| D8 | Native messaging off (exploration recommendation; the library path is removed) |
| Sessions | Granted apps served from the network join the default session; cache-served apps keep their partition, with no extensions, until pins move to the network path. Existing app data does not carry over (2026-09-29) |
| Filter | The stack filter, **and** granted apps' `script-src` loses `'unsafe-inline'`, which closes the inline-script route; apps that need inline scripts break (2026-09-29) |
| Shell | The multi-window shell (PR #38) landed first; extensions build on it. The extensions page is `orivon://extensions` (ADR-0041) |
| dNR | Port Firefox's matcher (2026-09-29) |

## What the measurements and audits add

- `electron-chrome-extensions` (GPL-3.0) gives `action`, `tabs`, `windows`, `contextMenus`,
  `cookies`, `notifications`, `webNavigation`, `commands`, `permissions`. It never touches
  `session.webRequest` or `https`. It spawns native-messaging hosts with no switch to turn that
  off, so it is **vendored with that path deleted** (Rule 6's written reason). Its action popup
  is a child `BrowserWindow`; accepted.
- `electron-chrome-web-store` (MIT) installs from the store and auto-updates. It checks no
  signature, so it is **vendored with a mandatory verifier hook** that Orivon fills with a
  CRX3 check requiring both the developer proof and the Web Store publisher proof.
- **Nothing implements `declarativeNetRequest`**: not Electron, not the libraries. The only
  production evaluator is Firefox's `ExtensionDNR.sys.mjs` (MPL-2.0, pure JS). Porting its
  matcher is the reuse path. uBlock Origin Lite also needs `userScripts`, `offscreen`, `alarms`.
- Any extension declaring `webRequest` or `declarativeNetRequest` makes Chromium proxy the
  session's URL loader, which bypasses `protocol.handle` (measured) and **crashes the main
  process on the first `net.fetch` on that session** (`extension-netfetch-probe.json`: SIGSEGV
  in 15 of 15 runs, every permission shape, default session and partitions alike; an embedder
  `webRequest` listener installed before the load avoided it in 3 runs, which is an observation,
  not a guarantee). Orivon calls `net.fetch` on the default session. So Orivon **owns each
  session's `webRequest`**, strips every `webRequest*` and `declarativeNetRequest*` permission
  (required and optional) from the manifest copy it loads, and serves those APIs from its own
  engine through the service-worker preload: a stub that stores rules from package 4, the real
  matcher in package 8. The loader also refuses to load anything before Orivon's own listener
  is on the session, as a second line.
- Real extensions end to end (`spike-results/extension-real-probe.json`: uBOL Lite 2026.926,
  Dark Reader 4.9.133, Bitwarden 2026.9.2, MetaMask 13.50): on bare Electron all four service
  workers die at startup on missing `tabs`/`webNavigation` events; content scripts run in top
  frames and in same- and cross-origin iframes. Electron's own dNR blocks with **dynamic and
  session** rules but never static ones, and **any** embedder `webRequest` listener silences all
  of it; MV3 `chrome.webRequest` delivers no event at all. A `service-worker` session preload
  also runs in websites' own workers, so it gates on `chrome-extension:` first. A polyfill that
  leaves a global in an extension page crashes MetaMask (LavaMoat scuttling). **With the library
  active** (stage F, npm 4.9.0): Dark Reader and Bitwarden workers survive and their popups
  render; uBOL's worker still dies at startup (to retest on vendored HEAD inside Orivon);
  Bitwarden needs `sidePanel.setOptions`; MetaMask's popup throws on LavaMoat's scuttled
  `chrome`, so the library's page injection needs a MetaMask-safe shape. Package 4 closes these.
- **Stack attribution from the isolated world is blind** (`extension-stack-probe.json`): a call
  across `contextBridge` shows only the preload's own two frames, whoever made it. Captured in
  the main world with references saved at install, it names the extension (section below).
- Why the Firefox matcher and not Electron's own dNR: Orivon needs `webRequest` listeners in the
  browsing session (the partition stamp; the T22 CSP once granted apps move in), which silence
  Chromium's dNR; static rulesets never load; and uBOL's rule count exceeds the dynamic and
  session caps it would have to be squeezed into.
- **2026-09-29, package 4 wiring, real extensions (`test/e2e-extensions-real.test.ts`, uBOL Lite
  2026.926, Dark Reader 4.9.133, Bitwarden 2026.9.2, MetaMask 13.50.0), before/after:**

  | Extension | Before | After |
  |---|---|---|
  | uBOL | SW dies (`Cannot read 'onRemoved'`); popup untested | SW runs 10s but still throws the same error (chrome.windows incomplete); popup renders (bodyLen 4) |
  | Dark Reader | SW dies same way | SW runs 10s, same error still logged; popup renders (bodyLen 20); style injection into a page still does not happen (waits on its SW) |
  | Bitwarden | SW dies (`Cannot read 'onCommitted'`) | SW runs 10s, same error still logged; popup fails to LOAD at all (`ERR_FAILED (-2)`, a separate, unexplained finding); its document_start content script (SW-independent) responds correctly |
  | MetaMask | SW dies; popup throws LavaMoat scuttling | SW runs 10s but still throws `Cannot read 'onRemoved'` AND the identical LavaMoat scuttling error; popup still empty (bodyLen 0), same LavaMoat error; its MAIN-world `window.ethereum` injection (SW-independent) works |

  Root cause found for the "does not take effect" service-worker gap: not a narrow timing race.
  **Every `'service-worker'`-type `session.registerPreloadScript` is silently never invoked, for
  any worker, when Electron launches with `--no-sandbox`** -- which every automated launch in
  this repo needs (its own vendored `chrome-sandbox` helper is not setuid-root). Reproduced 100%
  in a dependency-free single-file Electron app with only that one flag added; never reproduced
  without it; a second, empty preload registered right after the library's own also never ran;
  unloading and reloading the same extension never recovered it. `docs/open-questions.md` A289
  is open on whether Orivon's packaged, normally-launched app is affected too.
  `extension-sw-preload-recovery.ts` + `extension-sw-verify.ts` detect a worker that missed its
  preload (a main-initiated health check, not a worker-announced one -- the first version tried
  was itself measured to lose the race under `--no-sandbox`) and reload it once, which recovers a
  genuinely transient miss but not a `--no-sandbox` one. `chrome.declarativeNetRequest`,
  `chrome.sidePanel`, `chrome.userScripts` and the rest of `chrome.webRequest` are now present
  (stubs -- UPSTREAM.md patch 10), so an extension's startup code no longer throws calling or
  feature-detecting them; none of them enforce anything yet. The `enumerable: false` MetaMask
  attempt (UPSTREAM.md patch 11) was measured NOT to fix the LavaMoat crash by itself. The
  `chrome.runtime.openOptionsPage()`/`chrome.tabs.create()`-to-`chrome-extension:` crash
  (`test/e2e-extensions-toolbar.test.ts`'s own header) is now a confirmed SIGSEGV (exitCode 139
  on `render-process-gone`), still unfixed; the popup's own preload was ruled out as the cause.
  `crx-msg`'s sender-id spoof (UPSTREAM.md patch 9) is fixed and unit-tested.

- **2026-09-29, same day, re-measured sandboxed** (`launchElectron`'s new `sandbox` option, which
  passes Playwright's `chromiumSandbox: true` -- the `--no-sandbox` above turned out to be a
  Playwright-launcher default, not an Orivon or kernel requirement; this machine allows
  unprivileged user namespaces). Before/after, same four extensions:

  | Extension | Before (`--no-sandbox`) | After (sandboxed) |
  |---|---|---|
  | uBOL | SW dies; popup untested | SW runs, popup renders (bodyLen 10827); own check passes |
  | Dark Reader | SW dies | SW runs, popup renders (bodyLen 18304), style injection works |
  | Bitwarden | SW dies; popup `ERR_FAILED` | SW runs, popup renders (bodyLen 596), content script responds |
  | MetaMask | SW dies; popup LavaMoat crash | SW runs, popup renders (bodyLen 2931), `window.ethereum` works |

  All four pass every check sandboxed. The service-worker preload DOES run sandboxed, but the
  FIRST worker of a freshly loaded extension still races its registration and misses every time
  (measured: 20/20 cold starts of a fixture extension, and 4/4 of these real ones);
  `extension-sw-preload-recovery.ts`'s existing one-time reload recovered every single miss (0
  failures after reload, same runs), so it stays -- the race is real and sandbox-independent, not
  a `--no-sandbox` artifact. MetaMask's LavaMoat "scuttling mode" crash is fixed (UPSTREAM.md
  patch 12): it throws only for a CONFIGURABLE own property of `globalThis`, and Electron's
  `chrome` global is one by default, unlike (believed) real Chrome's own native binding; locking
  it to non-configurable/non-writable after injection stops the throw, measured 0 occurrences
  across a run that previously threw it in both the popup and the worker every time. The
  `chrome.runtime.openOptionsPage()`/`chrome.tabs.create()`-to-`chrome-extension:` SIGSEGV is gone
  sandboxed (`test/e2e-extensions-toolbar.test.ts` now asserts it directly): Chromium's real
  namespace sandbox, not the popup's own preload or extension-host.ts's URL policy, was the actual
  precondition the crash needed. An occasional popup-open failure remained under the four-
  extension launch specifically (a stray `ERR_FAILED (-2)` on one popup's navigation, or a popup
  window that had not yet registered by the wait deadline) -- not reproduced at all across three
  isolated single-extension retries, so a timing artifact of four popups/workers settling at once
  contending for the same process, not a library bug. `e2e-extensions-real.test.ts`'s popup check
  now retries its click+wait up to 3 times before failing, which measured 3/3 clean full runs
  afterward (0/3 before). The popup-body check itself was also measured unsafe for a
  LavaMoat-scuttled page regardless of this: `page.evaluate()` throws on `setInterval` (not in
  LavaMoat's own scuttle exceptions list), unrelated to whether the popup's real content rendered
  -- the check now reads `popup.content()` instead, which needs no script execution in the page.

## The session model D2 implies

One extension instance means one session. Today every origin with a grant or a pinned cache gets
`persist:app-<sha256>` (ADR-0018, ADR-0003, ADR-0007), so D2 as stated reverses owner-decided
isolation. What depends on it (code map, 2026-09-28):

- **Storage.** App-to-app separation becomes the ordinary same-origin separation of one
  session. Caveat: every `<cid>.ipfs.orivon` is one *site* to Chromium (`ipfs.orivon` is not a
  public suffix), so cookies with `Domain=ipfs.orivon` are shared across IPFS apps. True today for
  ungranted IPFS pages; granted ones would lose the partition that hid it.
- **T22 CSP.** Moves from one `onHeadersReceived` per app partition to the default session's
  single owner, keyed by the response's origin. Straightforward.
- **Pinned cache (ADR-0007).** `protocol.handle('https')` takes the whole scheme for a session
  and fails closed only because the session holds one origin. It cannot move into a shared
  session, and extensions with network permissions bypass it anyway. Cache-served origins keep
  their partition in this plan (extensions do not run there) until pinned bundles are served on
  the network path instead: the verifier's loopback host through a per-session proxy rule, so
  that dNR and extensions see ordinary requests. A later package, with its own ADR.
- **Existing app data** in `persist:app-*` does not carry over; granted apps start with empty
  storage in the default session once. Pre-release, so accepted unless the owner objects.

ADR (owner confirmed 2026-09-29): *extensions run in one browsing session; a grant no longer
implies a partition, a pinned cache still does.*

**Profiles and private sessions** (ADR-0042) are separate processes, each with its own data
directory, so each profile has its own registry and its own extension instances, as in Chrome.
A private session starts from a fresh directory and so runs no extensions; letting a person
allow one in private windows is a later choice, not part of this plan.

## Refusing extension code at `window.orivon` (D2)

Layered, strongest first:

1. **Isolated-world content scripts** never see `window.orivon` (Chromium, measured).
2. **Extension service workers and pages** get no `orivon` without `self`; the broker refuses
   `chrome-extension:` callers without it and reads the manifest itself.
3. **Main-world code on a granted origin**: the main-world `orivon` object, using intrinsics
   saved when the preload installs it, captures the structured call stack of every call and
   refuses when a frame or an eval origin is `chrome-extension://`, when no frame is an
   `http(s)` script, or when the stack machinery was frozen (measured,
   `extension-stack-probe.json` `mainWorld`, about 5 microseconds a call). It catches MAIN
   content scripts, registered and file-injected scripts, web-accessible `<script>`, `eval`,
   `new Function`, string timers, `javascript:` URLs, `scripting` func injection and deferred
   bound calls; `blob:`/`data:` scripts are already refused by the granted-app CSP. It applies
   only on an origin where some enabled extension without the permission has host access, so a
   person with no extensions sees no change. **This is a filter, not a sandbox**, and the
   remaining routes are stated in the security model in the manner of ADR-0021: an extension
   can change what the page itself submits, and can freeze `Error` to make every `orivon` call
   on that page refuse (a denial of service it could cause anyway). The inline-script route (an
   extension writes a `<script>` that runs as page code) is closed by dropping `'unsafe-inline'`
   from granted apps' `script-src` (owner, 2026-09-29): the T22 builder in
   `src/loader/serve/csp.ts` for cached apps and the appended policy for network-served ones.
   For a pinned bundle Orivon can add `'sha256-...'` sources for the inline scripts in the HTML
   it serves, so a cached app keeps its own inline scripts; a network-served granted app loses
   them.
4. **Disclosure** (exploration N2): grant prompts and the site-info popup name the extensions
   with host access to that origin.

## Work packages

Each is executed by a Sonnet agent from a brief; Opus reviews every diff before it is committed.

| # | Package | Depends on | PR |
|---|---|---|---|
| 1 | Vendor both libraries, patched; deps; build entries; guards skip `vendor/` | none | day PR A |
| 2 | Privileged views move to an `orivon-shell` partition (chrome view, popovers, intro, notice); extensions never get file access, so `file://` dashboard stays out of reach | none | A |
| 3 | `src/main/extensions/`: registry (userData, atomic JSON), loader at boot into the default session, install from folder / `.zip` / `.crx` with CRX3 check, manifest copy that strips `nativeMessaging`, `webRequest*` and `declarativeNetRequest*` into a recorded side table, uninstall, enable/disable. `src/broker/policy/extension-manifest.ts` (durable, pure): host patterns, MAIN-world use, the `orivon` key rejected until package 9, install-prompt lines, the T19 update re-prompt rule | 1 | A |
| 4 | Library wiring: `ElectronChromeExtensions` on the default session, `TabManager` bridge across windows, `<browser-action-list>` in the toolbar replacing the disabled button, `crx://` icons on the shell session, popups | 1-3 | A |
| 5 | Extensions page at `orivon://extensions` (ADR-0041's internal pages): list, details with **source and updater always shown**, enable, remove, install from folder/file, developer mode | 3-4 | B |
| 6 | Session model: granted network-served origins in the default session; T22 CSP and the partition stamp under one `webRequest` owner per event | owner confirms | C |
| 7 | Chrome Web Store: vendored installer and updater behind the CRX3 verifier; install from the store page; updater state shown per extension | 3, 5 | B |
| 8 | `declarativeNetRequest` from Firefox's matcher (MPL-2.0, vendored) + `webRequest` observation + `userScripts`/`offscreen`/`alarms` gaps, driven by uBOL Lite and AdGuard MV3 | 3, 6 | D |
| 9 | Stack-attribution refusal, granted-app `script-src` without `'unsafe-inline'` (hashes for pinned inline scripts), N2 disclosure; then `self` and `hook` (ADRs; contracts PR first, alone) | 6 | E, then contracts |

Day PRs: A (packages 1-4) and B can open the same day; C needs the owner; D and E follow.

## Tests each package leaves

- Unit (Vitest): CRX3 verifier against real `.crx` files and tampered copies; registry
  transitions; manifest policy; dNR matcher against Chrome's documented precedence cases.
- E2E (`test/e2e-extensions-*.test.ts`, fixture extensions under `test/apps/extensions/`): a
  content script runs on a fixture page; the action button appears and its popup opens;
  `window.orivon` is absent on the extension's own page; a `nativeMessaging` extension gets the
  refusal; nothing loads with file access; the chrome view never receives a content script.
- A guard (`check:vendor`) keeping `child_process` out of `vendor/`.

## Records

ADRs: vendoring and the fork reason; the session model (after owner confirmation); the
extension principal and `orivon` key; dNR ownership of `webRequest`. `security-model.md`: T4
rewritten (the ordinary-tab preload exposes `orivon`; the contradiction is filed first), plus
the exploration §9 rows and item 3 above. `scope.md` IN row. `ARCHITECTURE.md` §Where things
live: `vendor/`, `src/main/extensions/` (tied), manifest policy (durable). Compatibility
matrix: a Chrome extensions line.
