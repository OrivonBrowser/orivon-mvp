# Upstream

- Source: https://github.com/samuelmaddock/electron-browser-shell, `packages/electron-chrome-extensions/`
- Commit: `354b0b8192e8c2d960e50cf108b5dbbb70448fec`
- Date: 2026-09-01
- License: GPL-3.0 (see `LICENSE.md`, `LICENSE-GPL`, `LICENSE-PATRON.md`), combinable with
  Orivon's AGPL-3.0-only under GPLv3 §13
- Vendored from: `packages/electron-chrome-extensions/src/` (no `spec/`, no build output)
- Modified: by the Orivon project, as the patches below list; last modified 2026-09-30

## Patches

1. **Remove native messaging entirely.** Deleted
   `src/browser/api/lib/native-messaging-host.ts` and `src/browser/api/lib/winreg.ts`. In
   `src/browser/api/runtime.ts`, `connectNative`, `disconnectNative` and `sendNativeMessage` now
   throw `Error('Native messaging is not supported in Orivon')` instead of spawning a host
   process; the IPC handlers stay registered so an extension gets that error rather than a
   silent hang. Reason: native messaging starts a desktop program, native code outside
   Orivon's broker, which Orivon does not run.
2. **Explicit preload path.** `src/browser/index.ts`: added `preloadPath?: string` to
   `ChromeExtensionOptions`; when set, `prependPreload()` uses it instead of
   `resolvePreloadPath()`. Reason: Orivon bundles this preload itself and never installs from
   `electron-chrome-extensions/preload`.

3. **Icon response body type.** `src/browser/api/browser-action.ts` (the `crx://` icon
   handler): `new Response(iconImage.toPNG(), ...)` becomes
   `new Response(new Uint8Array(iconImage.toPNG()), ...)`. Reason: the DOM lib bundled with
   Orivon's TypeScript 7 no longer accepts a `Buffer<ArrayBufferLike>` as `BodyInit`; the bytes
   are unchanged.
4. **`navigateTab` impl hook.** `src/browser/impl.ts`: added an optional
   `navigateTab?(tab, url)` to `ChromeExtensionImpl`. `src/browser/api/tabs.ts`'s `update()`
   calls it instead of `tab.loadURL(url)` directly when the app supplied one. Reason: a
   `chrome.tabs.update({ url })` call must pass through Orivon's own URL policy
   (`src/main/extensions/extension-url-policy.ts`), the same as a created tab; without this hook
   the library loads the URL unchecked.
5. **`crx-msg-remote` sender check.** `src/browser/router.ts`: added
   `setRemoteMessageSenderCheck(check)` and an optional module-level predicate, checked in
   `onRemoteMessage` before a remote call reaches any observer. Reason: `crx-msg-remote` (the
   `browserAction.activate`/`getState`/`addObserver`/`removeObserver` calls a
   `<browser-action-list>` makes) is otherwise open to any sender in any session this process
   observes; Orivon restricts it to a chrome view (`extension-host.ts`'s `attachExtensionShell`).
   `crx-msg` is naturally scoped to a `chrome-extension:` page or service worker already
   (`src/preload.ts` only calls `injectExtensionAPIs()` there), and requires an `extensionId`
   registered in the calling session -- but trusted whichever id the message named until patch 9
   below.
6. **One `registerSchemesAsPrivileged` call site.** `src/browser/api/browser-action.ts`: removed
   the module-level `protocol.registerSchemesAsPrivileged([{ scheme: 'crx', ... }])` call.
   Reason: ADR-0041 gives Orivon exactly one call site for that API
   (`src/main/pages/internal-session.ts`, before ready); `crx` is registered there instead, with
   the same `bypassCSP` privilege.
7. **`override` on two accessors.** `src/browser-action.ts`'s `BrowserActionElement`:
   `get id()`/`set id()` (override `Element.id`) now say `override`. Reason: root tsconfig's
   `noImplicitOverride`, which `vendor/tsconfig.json` does not set; no behaviour change.
8. **Three fields widened to `| undefined`.** `src/browser-action.ts`'s `BrowserActionElement`:
   `updateId?: number`, `badge?: HTMLDivElement` and `pendingIcon?: HTMLImageElement` each gained
   `| undefined` -- the class already assigns `undefined` to all three. Reason: root tsconfig's
   `exactOptionalPropertyTypes`, which `vendor/tsconfig.json` does not set; no behaviour change.
9. **`crx-msg`/`crx-add-listener`/`crx-remove-listener` sender-id check.** `src/browser/
   router.ts`: added `setMessageSenderIdCheck(check)` and an optional module-level predicate,
   checked in `onRouterMessage`, `onAddListener` and `onRemoveListener` before a message reaches
   `onExtensionMessage` or a listener is added or removed. Reason: `onExtensionMessage`'s
   permission checks, and `addListener`/`removeListener`'s own subscriptions, all trust the
   `extensionId` argument the message itself carries, which a page or worker of one loaded
   extension can set to any other loaded extension's id by calling
   `window.electron.invokeExtension`/`addListener`/`removeListener` directly, not only through the
   generated `chrome.*` wrappers -- letting it read another extension's own events, not only call
   its handlers. Orivon wires this to derive the real id from the sender's own
   `chrome-extension://<id>/` URL (`src/main/extensions/extension-sender-id-check.ts`) and refuse
   a mismatch -- `crx-msg-remote` already had an equivalent check (patch 5); this is its `crx-msg`
   counterpart, now covering all three channels a claimed extension id can arrive on.
10. **`declarativeNetRequest`, `sidePanel`, `userScripts`, and the rest of `webRequest`.**
    `src/renderer/index.ts`'s `apiDefinitions`: added factories for all four, following the
    file's own existing pattern (a `webRequest.onHeadersReceived`-only stub was already there).
    Reason: entirely absent otherwise, so an extension whose startup code calls or feature-
    detects any of them throws before it does anything else. `sidePanel` and `userScripts`
    resolve as no-ops: no real side panel, no real user script world.
    `declarativeNetRequest` is real, wired by patches 43 and 44 below to Orivon's own engine
    (`src/main/extensions/dnr/`, `src/main/extensions/extensions-dnr.ts`).
11. **Non-enumerable API properties.** `src/renderer/index.ts`'s per-API `Object.defineProperty
    (chrome, apiName, ...)`: `enumerable: false`, was `true`. Kept as a harmless extra guard;
    MEASURED not to fix MetaMask's LavaMoat "scuttling mode" crash by itself (patch 12 is what
    fixes it). `contextBridge.exposeInMainWorld('electron', electronContext)` is unchanged for a
    related reason: a frame's own isolated world has no closure once `executeInMainWorld`
    re-evaluates `mainWorldScript` with none (its own comment), so removing it would break every
    frame's chrome.* injection, not only MetaMask's, and was never shown to help.
12. **Lock the top-level `chrome` global to non-configurable/non-writable.** `src/renderer/
    index.ts`'s `mainWorldScript`, after every API is attached:
    `Object.defineProperty(globalThis, 'chrome', { value: chrome, writable: false, configurable:
    false })`, guarded to only run when the existing property was still configurable. Reason:
    MetaMask's own LavaMoat "scuttling mode" walks every CONFIGURABLE own property name of
    `globalThis` (and its prototype chain) and replaces it with a throwing accessor; a
    non-configurable, non-writable property is the one case its own code skips outright. MEASURED:
    a real MetaMask 13.50.0 popup and service worker no longer throw "property 'chrome' of
    globalThis is inaccessible under scuttling mode" with this patch (0 occurrences across a full
    real-extensions run that previously threw it in both contexts every time), and the popup
    renders its real content -- read through Playwright's `page.content()`, not `page.evaluate()`
    (`test/e2e-extensions-real.test.ts`'s own comment: `evaluate()` throws on `setInterval`, a
    global LavaMoat's own scuttle exceptions list does not carry, so it is unsafe against a
    scuttled page regardless of this patch). Provisional: real Chrome's own native `chrome`
    binding is believed non-configurable for the same reason (so a real Chrome extension's own
    LavaMoat setup never needed to protect it) -- unconfirmed against real Chrome's own internals.
13. **`Session` imported type-only.** `src/browser/router.ts`: `import { app, ipcMain, Session }
    from 'electron'` split into a value import (`app`, `ipcMain`) and `import type { Session }`.
    Reason: root tsconfig's `verbatimModuleSyntax`, which `vendor/tsconfig.json` does not set;
    `Session` is used only as a type here; no behaviour change.
14. **One field widened to `| undefined`.** `src/browser/router.ts`'s `HandlerOptions`:
    `permission?: chrome.runtime.ManifestPermissions` gained `| undefined` -- `handle()` already
    assigns it `undefined` when no permission is given. Reason: root tsconfig's
    `exactOptionalPropertyTypes`, which `vendor/tsconfig.json` does not set; no behaviour change.
15. **`setEventListenerFilter` per-listener event filter.** `src/browser/router.ts`: added
    `setEventListenerFilter(filter)` and an optional module-level predicate, applied in
    `sendEvent` to every listener's own arguments right before delivery. Returning `undefined`
    from `filter` skips delivery to that one listener; returning a replacement array delivers
    that instead. Reason: `cookies.onChanged` and `tabs.onCreated`/`onUpdated` broadcast the
    same arguments to every listening extension regardless of what that extension may see --
    patches 16 and 18 below are what `extension-host.ts` uses this hook for
    (`src/main/extensions/README.md`'s Design notes).
16. **`chrome.cookies`: the `cookies` permission, plus a host-access hook.** `src/browser/
    api/cookies.ts`: every handler (`get`/`getAll`/`set`/`remove`/`getAllCookieStores`) now
    declares `permission: 'cookies'` (router.ts's own `permission` option, patch 14 above);
    `get`/`set`/`remove` refuse a URL the extension has no host access to, and `getAll` filters
    its results to only the cookies it does, through an injected `setCookieHostAccessCheck(check)`
    predicate (the same shape as patch 9's sender-id check) -- unset, or before this patch,
    `chrome.cookies` read and wrote every cookie of the session for any extension holding no
    permission at all. `onChanged`'s own per-listener gating is patch 15's hook, wired in
    `extension-host.ts`. Also: `ExtensionContext`/`ExtensionEvent` imported type-only, `cookies[0]`
    (an array read) no longer assumed defined, and the objects passed to `session.cookies.get`/
    `set` built or cast to satisfy `exactOptionalPropertyTypes` -- reasons: root tsconfig's
    `verbatimModuleSyntax`/`exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`, none of which
    `vendor/tsconfig.json` sets; no behaviour change from any of these four. Together, this makes
    `api/cookies.ts` satisfy the root tsconfig too, the same choice patches 13-14 made for
    router.ts, so `src/main/extensions/tests/` can unit-test this patch directly against the real
    file.
17. **Three fields imported type-only.** `src/browser/store.ts`: `ContextMenuType`,
    `ChromeExtensionImpl` and `ExtensionEvent` each used only as a type here, now `import type`.
    Reason: root tsconfig's `verbatimModuleSyntax` -- `store.ts` sits on the import path patch 16
    puts under the root tsconfig too (`ExtensionContext`'s own field type); no behaviour change.
18. **`chrome.tabs`: url/title/favIconUrl gated on `tabs` or a matching host permission.**
    `src/browser/api/tabs.ts`: added `setTabUrlAccessCheck(check)` (patch 16's own shape) and a
    `filterTabDetails` helper applied everywhere a `chrome.tabs.Tab` is returned or broadcast
    (`get`/`getAllInWindow`/`getCurrent`/`create`/`update`/`query`) -- unset, or before this
    patch, every one of those calls returned `url`/`pendingUrl`/`title`/`favIconUrl` regardless of
    permission. `query`'s own `url`/`title` filters now exclude a tab whose matching field this
    filter stripped, instead of treating a stripped (`undefined`) field as a non-filtering match.
    `onCreated`/`onUpdated`'s own per-listener gating is patch 15's hook, wired in
    `extension-host.ts`. Also: `ExtensionContext`/`ExtensionEvent`/`TabContents` imported
    type-only, and `page-favicon-updated`'s own handler no longer assigns a possibly-`undefined`
    array read where `TabContents.favicon` wants `string | undefined` only when actually present
    -- reasons: root tsconfig's `verbatimModuleSyntax`/`exactOptionalPropertyTypes`, which
    `vendor/tsconfig.json` does not set; no behaviour change beyond the query fix already
    described. Together with patch 16's own note, this makes `api/tabs.ts` satisfy the root
    tsconfig too, for the same testability reason.
19. **`chrome.webNavigation`: the `webNavigation` permission.** `src/browser/
    api/web-navigation.ts`: `getFrame` and `getAllFrames` now declare `permission:
    'webNavigation'`. Reason: neither handler checked for any permission at all -- any loaded
    extension could read every frame's URL in any tab. The events this class broadcasts
    (`sendNavigationEvent`) are gated the same way, per listener, through patch 15's hook. Also:
    `ExtensionContext`/`ExtensionEvent` imported type-only, for the same root-tsconfig reason as
    patches 16 and 18, and for the same testability goal.
20. **Two fields imported type-only.** `src/browser/api/windows.ts`: `ExtensionContext` and
    `ExtensionEvent`, used only as types here, now `import type`. Reason: `tabs.ts` (patch 18)
    imports `WindowsAPI` from this file as a value, which puts this file on the same root-tsconfig
    import path; no behaviour change.
21. **`chrome.windows.*`: the same url/title/favIconUrl gate as patch 18, plus `populate`.**
    `src/browser/api/windows.ts`: `filterTabDetails` (patch 18) exported from `api/tabs.ts`, and a
    new `toExtensionWindow` maps every window's own `tabs` array through it for the calling
    extension. `tabs` itself is now included only when `getInfo.populate === true`
    (get/getAll/getCurrent/getLastFocused; `create` always populates its own newly opened tabs;
    `update` takes no `populate` option at all, so it never carries `tabs`). Before this patch,
    every one of get/getAll/getCurrent/getLastFocused/create/update handed any extension every
    open tab's url/title/favIconUrl regardless of permission, unconditionally. `windows.onCreated`/
    `onBoundsChanged` keep broadcasting the unfiltered, shared `windowDetailsCache` entry (as
    before) -- their own per-listener stripping is patch 15's hook, wired in `extension-host.ts`.
22. **`crx-add-listener`/`crx-remove-listener` never throw out of the ipcMain.on listener.**
    `src/browser/router.ts`: `onAddListener`/`onRemoveListener` wrap their own
    `addListener`/`removeListener` calls in try/catch, logging and swallowing rather than letting
    a throw escape. Reason: both run inside a plain `ipcMain.on` listener, never awaited by
    anything -- `addListener` throws synchronously for an extensionId no longer registered in the
    session (an options tab left open across a disable/uninstall, or a page whose extension is
    mid-reload), and an uncaught throw there becomes an `uncaughtException` in `src/main/index.ts`,
    which exits the whole process for one page's stale subscription. `onRouterMessage`/
    `onRemoteMessage` need no equivalent guard: both are `async`, so a throw there already becomes
    a rejected `ipcMain.handle` promise, which Electron forwards to the caller without crashing.
23. **`chrome.tabs.insertCSS`: host access, never the `tabs` permission alone.** `src/browser/
    api/tabs.ts`: a second setter, `setTabHostAccessCheck(check)` (patch 18's own shape), checked
    in `insertCSS` against the target tab's URL. Reason: `insertCSS` had no permission check of
    any kind -- any loaded extension could inject CSS into any tracked tab; and the `tabs`
    permission alone (which patch 18's own `gTabUrlAccessCheck` accepts) never authorizes an
    injection under Chrome's own rule, only url/title/favIconUrl visibility.
24. **`ExtensionStore.createTab` refuses a webContents from a different session.** `src/browser/
    store.ts`: the constructor takes an optional `session` (patch 25 below passes its own),
    stored and checked in `createTab` against the returned webContents's own `.session`, alongside
    the existing "must be a WebContents"/"must be a BrowserWindow" checks; a mismatch throws
    rather than calling `addTab`. Reason: `ElectronChromeExtensions.addTab`'s own
    `checkWebContentsArgument` already refuses a host-initiated call for the wrong session, but
    `createTab` (an extension's own `chrome.tabs.create`) never went through it -- an app's
    creator function can legitimately open a granted app's URL in that app's OWN session (its own
    partition), and without this check the extension still received that tab's id, and could
    update/reload/insertCSS into it and receive its webNavigation events, in a session none of its
    own permissions ever covered. The tab itself is left open; only the extension's own request is
    refused.
25. **`ExtensionStore` constructed with the session, for patch 24.** `src/browser/index.ts`:
    `new ExtensionStore(impl, session)` in place of `new ExtensionStore(impl)`.
26. **`chrome.notifications`: the `notifications` permission.** `src/browser/api/notifications.ts`:
    all five handlers now declare `permission: 'notifications'` (router.ts's own `permission`
    option). Reason: none of the five checked for any permission at all -- any loaded extension
    could raise OS notifications. `src/renderer/index.ts`'s own `notifications` factory gained a
    matching `shouldInject`, the same belt-and-suspenders shape `cookies` and `webNavigation`
    already use.
27. **`browserAction.setPopup`/`default_popup`: only the extension's own origin.**
    `src/browser/api/browser-action.ts`: `getPopupUrl` now resolves `popupPath` against
    `chrome-extension://<extensionId>/` and refuses the result unless its own `protocol` and
    `hostname` still match -- an absolute URL naming any OTHER origin (`file:`, `data:`, an
    http(s) page, or a different extension's own `chrome-extension://<id>/`) returns `undefined`
    instead of being resolved and returned as-is. Reason: `PopupView.load()` hands whatever this
    returns straight to a main-process `loadURL`, with no pass through Orivon's own
    extension-url-policy at all -- before this patch, any extension whose page called
    `chrome.action.setPopup` could point its own toolbar button at an arbitrary URL.
28. **`ExtensionStore.clearActiveTab`, and `ElectronChromeExtensions.clearActiveTab`.**
    `src/browser/store.ts` and `src/browser/index.ts`: a new method clears `windowToActiveTab`'s
    own entry for a given window and emits `active-tab-changed`, exposed publicly the same way
    `selectTab`/`removeTab` already are. Reason: nothing in the public API let a host say "no
    tracked tab is active here" -- only "this specific tab is" (`selectTab`) -- so a host whose UI
    switched to a tab this library never learned about (`extension-host.ts`'s own doc) had no way
    to stop the library's own idea of the active tab from staying pointed at whatever tracked tab
    was active before.
29. **`observeTab`/`observeWindow` are idempotent.** `src/browser/api/tabs.ts` and `src/browser/
    api/windows.ts`: each keeps its own `WeakSet` of webContents/windows it has already attached
    listeners to, and returns immediately on a repeat. Reason: `tab-added`/`window-added` can fire
    again for the SAME webContents/window (a tab handed to another window, or a one-tab window's
    view replaced -- `extension-host.ts`'s own doc), and neither method checked for that before --
    a second call attached a second, independent listener set the `destroyed`/`closed` handler
    from the FIRST set never cleaned up (it only fires once, and only on the object's real
    destruction), doubling every `tabs.onUpdated`/`windows.onFocusChanged`/`onBoundsChanged`/
    `onRemoved` event from then on.
30. **A worker's own scope, not `process.type`, gates preload injection.** `src/preload.ts`:
    injects only when the context's URL is `chrome-extension:`. A frame reads `location.href`; a
    service worker's preload runs in Electron's preload realm, which has no `location`, so it
    reads the worker's own URL from its main world through `contextBridge.executeInMainWorld`.
    Reason: `process.type === 'service-worker'` alone injected into EVERY service worker this
    session preload runs for, including an ordinary website's own worker, handing it a
    non-deletable `self.electron` and a non-configurable `chrome` global it never should have had
    (a fingerprinting surface, and a `let chrome` in the page's own script throws).
31. **`api/browser-action.ts`, `popup.ts` and `api/notifications.ts` satisfy the root tsconfig.**
    Type-only imports (`ExtensionContext`/`ExtensionEvent`/`Extension`/`Session`), `| undefined`
    added to several already-optional fields and one constructor-options cast
    (`exactOptionalPropertyTypes`), and three `?? ''`/`?? {}`/`= 0` fallbacks where an array read
    or object index is now typed as possibly absent (`noUncheckedIndexedAccess`) -- the same
    reasons, and the same "no behaviour change" stance, as patches 13-14 and 16-20's own entries.
    Reason patches 27-28 above needed this: they touch `getPopupUrl`/`clearActiveTab`, both in
    files this suite's own tests (`browser-action-popup-url.test.ts`) now import by real path.
32. **`chrome.offscreen` and a real `chrome.runtime.getContexts`.** New
    `src/browser/api/offscreen.ts` (`OffscreenAPI`): `createDocument`/
    `closeDocument`/`hasDocument`, one never-shown, sandboxed
    `WebContentsView` per extension (see below), validated the way Chrome does
    (`url` resolved and refused unless it is the calling extension's own
    page; `reasons` non-empty and each a name from Chrome's own enum;
    `justification` a non-empty string; a second `createDocument()` while
    one is open throws Chrome's own "Only a single offscreen document may
    be created."), closed by `Session`'s own `'extension-unloaded'` event
    so disable, uninstall and a crash all tear it down through one native
    listener, no separate wiring from `extension-host.ts` needed.
    `src/browser/api/runtime.ts`'s `RuntimeAPI` gained two constructor
    parameters (`OffscreenAPI`, `BrowserActionAPI`) and a
    `runtime.getContexts` handler covering BACKGROUND
    (`session.serviceWorkers`), OFFSCREEN_DOCUMENT (the map above), POPUP
    (`browser-action.ts`'s own `getOpenPopup`, below) and TAB
    (`ExtensionStore.tabs` filtered to the calling extension's own pages),
    matching Chrome's `ContextFilter` fields (`contextTypes`, `contextIds`,
    `tabIds`, `windowIds`, `documentUrls`, `documentOrigins`, `incognito`).
    `src/browser/api/browser-action.ts` gained a public `getOpenPopup()`
    (its own `popupTabId` field, set alongside `this.popup`) for the POPUP
    entry -- PopupView itself carries no tab of its own. `src/browser/
    index.ts` constructs `OffscreenAPI` and `BrowserActionAPI` before the
    rest of `this.api`, both now needed by other API classes. Reason:
    absent from Electron and from this library entirely; MV3 tabCapture
    extensions (Volume Master among them) need `chrome.offscreen` to host
    the `getUserMedia()` call a capture stream id feeds into, and their own
    existence check for one prefers `getContexts`, falling back to
    `clients.matchAll()` only when it is absent -- measured directly, that
    fallback does not see a document `OffscreenAPI` creates, so the
    extension's own guard against a second `createDocument()` call never
    fires and the library's own guard throws instead. This shadows
    whatever partial native `chrome.offscreen` binding Electron 44 itself
    may carry: measured directly (a fixture's service worker and its
    frame contexts both read back `chrome.offscreen.createDocument`'s own
    source), `createDocument` is this library's `invokeExtension`-based
    wrapper in EVERY extension context, the service worker included, never
    a native one, and a `createDocument()` call creates exactly one new
    `chrome-extension://` `webContents` -- no second, native document
    alongside it.

    **`WebContentsView`, not a `BrowserWindow`.**
    The document was originally a hidden `BrowserWindow`; measured directly
    (docs/planning's tabCapture/offscreen probe) that a never-attached
    `WebContentsView` still gets this library's own preload and
    `chrome.runtime` messaging in full, and -- unlike the `BrowserWindow` it
    replaces -- contributes nothing to `BrowserWindow.getAllWindows()` at
    all. A hidden `BrowserWindow` DID count there, so an open offscreen
    document kept `src/main/index.ts`'s process alive past the last real
    shell window closing, and blocked its macOS `activate` handler from ever
    reopening one, since both read that same count.

    **Denies `window.open`, locks the document's own main-frame navigation
    to the extension's own origin.**
    `setWindowOpenHandler` denies every `window.open` from the
    document outright (the library's own default new-window handling
    otherwise opened a raw, frameless, always-on-top `BrowserWindow`); a
    shared `will-navigate`/`will-redirect` handler refuses any MAIN-FRAME
    navigation to a URL outside `chrome-extension://<the extension's own
    id>/`. `details.isMainFrame` gates both: `will-navigate` is documented
    to fire "on the main frame" only (never for a subframe's own plain
    navigation at all), but `will-redirect` fires "when a server side
    redirect occurs during navigation" in ANY frame -- ungated, the lock
    refused a real HTTP redirect inside a cross-origin `<iframe>` the
    offscreen document legitimately embeds, not only the document's own
    main-frame navigation the lock exists for. An offscreen document has
    no tab, no toolbar and no one watching it, so neither capability serves
    any real use and either one, left open, would let a compromised or
    malicious extension turn its own hidden document into an equally hidden
    window onto the rest of the web.

    **Cleans up on a renderer crash.** A `'render-process-gone'`
    listener drops the document's own map entry immediately -- its
    `WebContents` otherwise survives a crash on its own (`isCrashed()`'s own
    existence implies as much), so without this, `hasDocument`/
    `getContexts` kept reporting a crashed document present forever, and a
    fresh `createDocument()` kept throwing "Only a single offscreen document
    may be created." for one that could no longer do anything. Deliberately
    does NOT also call `close()` on the crashed `WebContents`: measured
    directly, `close()`'s own "as if `window.close()` had been called"
    contract waits on a beforeunload round trip a crashed renderer can never
    answer, reproducing as Chromium's own hung-process watchdog fataling the
    whole child process.
33. **`chrome.tabCapture.getMediaStreamId`, plus the activeTab-style
    invocation grant it requires.** New `src/browser/api/tab-capture.ts`
    (`TabCaptureAPI`): resolves `targetTabId` (or the active tab) through
    `ExtensionStore.getTabById`/`getActiveTabOfCurrentWindow` only, refuses
    a tab outside the extension's own session, refuses a target whose URL is
    not `http:`/`https:` (below), refuses one
    (`setTabCaptureAppRefusalCheck`, `src/main/extensions/extension-host.ts`)
    belonging to a granted app, refuses one the extension was never invoked
    on with Chrome's own error text ("Extension has not been invoked for the
    current page...", `setTabCaptureInvocationCheck`), resolves the
    capture's consumer as `consumerTabId` when given or else the extension's
    own open offscreen document (patch 32), then calls
    `webContents.getMediaSourceId()`. A successful call mutes the target
    tab's local playback (Electron duplicates a captured tab's audio instead
    of diverting it the way Chrome does -- measured directly: muting the
    source does not also silence what the consumer receives) and restores it
    once every capturer has released the tab: a closed tab, the ACTUAL
    consumer (the offscreen document, or the `consumerTabId` tab, below)
    being destroyed or crashing, `'extension-unloaded'`, the tab's own
    navigation newly failing the app-refusal or http(s) check (below),
    or -- the one still on a timer, and now per (extension, target
    tab), never per extension alone (below) -- a 10-second safety
    net for a minted id that was never actually redeemed, checked against
    `tab-capture-grants.ts`'s own `wasTabCaptureGrantConsumed`
    (`setTabCaptureConsumedCheck`), true only once `permission-gate.ts` has
    actually allowed a `'media'` REQUEST (never a CHECK, which fires
    speculatively with no `getUserMedia()` behind it -- measured, marking on
    it released an unredeemed grant early) for this exact
    (extensionId, targetTabId) pair. Originally built on `WebContents`'s own
    `'media-started-playing'` event; replaced after measuring directly
    that it fires for an `AudioContext` routed to `ctx.destination` too
    (the opposite of what was assumed), which said nothing about the one
    case the safety net actually exists for -- an id that was never
    consumed at all fires no media event either. `getCapturedTabs` and
    `onStatusChanged` are also implemented, scoped to the calling
    extension. `src/browser/api/
    browser-action.ts`'s `activateClick` calls a new optional
    `setTabCaptureInvocationRecorder` hook with the clicked tab, the same
    shape as `setEventListenerFilter`; `extension-host.ts`'s own wiring
    clears that grant when the tab closes or navigates to a different
    origin (`extension-tab-invocation.ts`'s ledger), and on the extension's
    own unload.

    **Also in `browser-action.ts`: the invocation was
    forgeable.** `browserAction.activate` exists solely for the chrome
    view's own `<browser-action>` element, which calls it EXCLUSIVELY over
    `crx-msg-remote` (`browser-action.ts`, the injected preload) -- no
    extension code is ever meant to reach it. Before this fix, nothing
    enforced that: a plain extension page could call it directly over the
    LOCAL `crx-msg` channel with a `details.extensionId`/`details.tabId` of
    its own choosing (fields inside the RPC payload, never checked against
    the caller's real, verified identity) and record an invocation -- or
    open another extension's popup, or fire its `onClicked` -- for a tab it
    had no access to. `chrome.action.openPopup()` (a real API, callable with
    no gesture at all) reaches the same `activateClick` by calling it
    directly, bypassing `activate`'s own router-level checks entirely, and
    used to record an invocation the same way a real click did. Fixed:
    `activate` now refuses outright whenever `event.extension` is defined --
    `router.ts`'s own `onRemoteMessage` ALWAYS passes `extensionId:
    undefined`, so `event.extension` is undefined for every genuine remote
    call (the one `setRemoteMessageSenderCheck`'s own `isFromChromeView`
    gate already restricts to the chrome view) and defined only for a local
    `crx-msg` call, whatever it claims. `activateClick` gained a
    `recordInvocation` parameter, `false` by default: `activate` passes
    `true` only once it has confirmed the call is genuinely remote;
    `openPopup` still calls `activateClick` directly (so the popup still
    opens, or `onClicked` still fires, exactly as before) but never passes
    it, so `chrome.action.openPopup()` can no longer mint an invocation.
    `src/browser/index.ts` constructs
    `TabCaptureAPI` with the same `OffscreenAPI` instance patch 32 already
    builds. Reason: absent from Electron entirely; only
    `webContents.getMediaSourceId(requestWebContents)` exists as the
    underlying primitive. `capture()` is not implemented: an MV3 extension
    using an offscreen document (patch 32) always calls `getMediaStreamId`
    and does its own `getUserMedia`, never `capture()`.

    **Additional fixes in this patch.**
    - **The `'media'` carve-out widened into real
      device access.** `../sessions/tab-capture-grants.ts`'s own
      `isTabCaptureMediaRequestAllowed` and `../sessions/permission-gate.ts`'s
      own doc comments have the full account -- a live tabCapture grant used
      to be allowed for any `'media'` request from its extension's origin,
      regardless of what the request actually asked for. Fixed at the
      request-handler level, not here; this file's own contribution is
      passing `targetTab.id` through `setTabCaptureGrantRecorder`/
      `setTabCaptureConsumedCheck` so the ledger can key on it.
    - **Consumption and release now key on (extension, target tab),
      never extension alone.** The old ledger and this file's own safety net
      both let one tab's redemption, or one tab's unconsumed-release timer,
      affect a DIFFERENT tab the same extension was also capturing.
    - **Capture-end now watches the real consumer, plus
      `'extension-unloaded'` directly.** The old code assumed the consumer
      was always the offscreen document and watched only ITS teardown;
      `observeConsumerTeardown` now watches whichever `WebContents`
      `getMediaStreamId` actually used (the offscreen document, or an
      explicit `consumerTabId`), for both `'destroyed'` and
      `'render-process-gone'`, and a direct `'extension-unloaded'` listener
      on this class covers a `consumerTabId` consumer that never itself
      dies. DECIDED, and deliberately not built: a periodic
      `isCurrentlyAudible()` poll on the consumer to catch "the extension
      stopped the track but kept the document open" -- a consumer that only
      records the stream (`MediaRecorder`, never played back audibly) is
      legitimately silent for a capture's entire real duration, and
      `media-paused`/`audio-state-changed` never fire for a `MediaStreamTrack`
      piped through Web Audio at all (Volume Master's own shape), so neither
      candidate signal is safe or general enough to build on.
    - **A target must be an `http(s)` tab.** `ctx.store` tracks
      every `wc.session === session.defaultSession` tab, which (ADR-0044)
      includes a granted app's own tab -- `setTabCaptureAppRefusalCheck`'s
      own job -- but ALSO another extension's own page (its popup or
      options page opened as a tab, another extension's offscreen document),
      which is not a granted app at all: `devtools-app-origin.ts`'s own
      `appOrigin` returns null for a `chrome-extension://` page, so the
      app-refusal check alone never refused it. DECIDED: refuse every
      non-`http(s)` target outright, the caller's own pages included, rather
      than carving out an exception for them.
    - **The app-refusal and http(s) checks are re-run on the
      captured tab's own navigation, and the app-refusal check again inside
      the `'media'` REQUEST handler itself.** A tab that was an ordinary page
      at mint time can navigate to a granted app's origin, or to a
      non-http(s) URL, without ever closing; `getMediaStreamId`'s own checks
      previously ran once, at mint, and never again. `recheckCaptureStillAllowed`
      (this file), wired to the captured tab's own `'did-navigate'`, ends
      every capture of it the moment either check newly refuses.
      `../sessions/permission-gate.ts`'s own `setTabCaptureMediaAppRefusalCheck`
      registration covers the second half: a live, still-unexpired grant
      handed to the REQUEST handler for a tab that has since become a
      granted app's own.
    - **The captured tab's own `'destroyed'`/`'did-navigate'`
      listeners are now removed on an ordinary release.** Previously
      attached once per tab and never removed unless the tab itself was
      destroyed -- releasing a capture without the tab dying (the ordinary
      case) left one more armed listener on it, stacking with every
      capture/release cycle of the same tab.
    - **A probable crash: reading `tab.id` from inside the captured tab's
      own `'destroyed'` handler.** `Electron.WebContents` throws "Object
      has been destroyed" reading almost any property once destroyed,
      `.id` included; the tab's own `'destroyed'` handler fires exactly
      when that is already true, so `endCapture`'s own `captureKey(...,
      tab.id)` crashed the process the moment a captured tab closed
      (uncaught inside the event emission, then `index.ts`'s own
      `exitOnUncaught`). `CapturedTabRecord` now carries a `tabId` captured
      once, while the tab is still alive; every release path reads that
      field, never `tab.id` again. The identical pattern in
      `../../../src/main/extensions/extension-tab-capture-invocation.ts`'s
      own `recordTabCaptureInvocation` (browser-action.ts's own invocation
      recorder) is fixed the same way.
    - **A second `getMediaStreamId` for a tab already being captured must
      be refused, matching Chrome's own "Cannot capture a tab with an
      active stream."** Re-minting an already-consumed (extension, tab)
      pair reset `tab-capture-grants.ts`'s own `consumed` bit back to
      `false`, so the fresh mint's own 10-second safety net could end the
      still-running FIRST capture (unmuting the tab, firing `'stopped'`)
      out from under it. `getMediaStreamId` now refuses outright whenever
      the calling extension already holds an active capture of the target
      tab, before ever minting a second grant.
    - **The `'media'` carve-out's own `mediaTypes: []`/`contents.id`
      checks do not, on their own, tell a real tab capture apart from
      `chromeMediaSource: 'desktop'`.** MEASURED:
      `getUserMedia({mandatory: {chromeMediaSource: 'desktop'}})` ALSO
      reports `mediaTypes: []`, and succeeds once permitted (measured,
      with `--use-fake-device-for-media-stream`) -- this carve-out is
      exploitable, not merely theoretical. A web-accessible
      `chrome-extension://` page the extension injects as an `<iframe>`
      into the SAME tab it minted a grant for shares that tab's own
      `WebContents` (a page and its iframes are one `WebContents`), so
      `contents.id` there equals the granted tab too, matching every
      existing check. `PermissionRequest.isMainFrame` (electron.d.ts) is
      the field that survives: every legitimate tab-capture/offscreen-
      document request measured here reports `true`; an iframe's own
      request, by the same documented contract, does not.
      `isTabCaptureMediaRequestAllowed` now requires it.
      `../sessions/tab-capture-grants.ts`'s own doc has the full
      measurement, including that a live iframe reproduction of this exact
      shape could not be obtained in this environment (the call hung
      before ever reaching the permission handler, for reasons not fully
      diagnosed) -- the fix rests on Electron's own documented
      `isMainFrame` contract and a direct unit test against the policy
      function, not an end-to-end reproduction of the attack itself. (The
      offscreen document's OWN `will-navigate`/`will-redirect` lock gained
      the identical `isMainFrame` gate -- patch 32's own entry above.)
34. **`popup.ts`: a popup closes on more than its own `blur`.** `PopupView`'s constructor now also
    closes it when the parent window moves, resizes or minimises (`'move'`/`'resize'`/`'minimize'`,
    all removed again in `destroy()`), and when Escape is pressed inside it
    (`webContents.on('before-input-event', ...)`) -- Chrome does all three. A new
    `closeOnNextAppFocus` also arms once `maybeClose`'s own "keep it open, focus may have left the
    app for a login form" guard triggers: on some window managers (measured on this project's own
    X11 desktop) focus handing from the popup to whichever window the person clicked is not atomic
    with the `blur` that reports it, so for a brief instant neither the popup nor the parent
    reports itself focused -- indistinguishable, at that instant, from a genuine departure to
    another app. Since `blur` fires only once, missing this reading left the popup stuck open for
    good. The one-shot fallback listens for the next `'focus'` on any other window `getAllWindows()`
    already knows about, or on any webContents inside the parent's own content-view tree (a tab or
    toolbar view can gain Chromium's own internal input focus without the parent `BaseWindow`
    itself re-firing `'focus'`, if it was never the one that lost native focus to begin with) --
    whichever fires first closes the popup and disarms the rest. Reason: a popup that never
    reliably closes on its own is a correctness bug independent of platform, and the added closes
    match Chrome's own documented behaviour.
35. **`popup.ts`: a popup can never stay permanently invisible, and no longer flashes white in
    dark mode.** Two independent, narrow changes to the same constructor. First,
    `armVisibilityFallback`: a preferred-size-capable popup (Electron 12+, the only case this
    project ships) has exactly one path to `show()` -- `'preferred-size-changed'`, an event
    Chromium's own layout/compositor pipeline emits with no guarantee of promptness, or of firing
    at all (measured: it never fires under a GPU-less headless display). Nothing before this patch
    gave such a popup a second way to become visible; it would stay `show: false` --
    fully loaded and interactive over CDP, but invisible and unfocusable to a real person -- for
    its entire life. A 500ms timer now shows it anyway, at a fixed reasonable size
    (`FALLBACK_BOUNDS`, 320x400) positioned against the same anchor rect `updatePosition()`
    always uses, if `'preferred-size-changed'` has not arrived yet -- `updatePosition()` runs
    before `show()`, since showing first would flash the popup at the wrong spot for one frame
    before it jumped to the right one; a later `'preferred-size-changed'` still resizes and
    repositions it correctly on arrival regardless (`updatePreferredSize` does not check `hidden`
    first). Second, the `backgroundColor` passed to
    `new BrowserWindow(...)` -- paints before the extension's own popup page has a pixel to show --
    now follows `nativeTheme.shouldUseDarkColors` instead of always being `'#ffffff'`. Reason: a
    fixed light background flashed white for a moment on every popup open in dark mode.
36. **`router.ts`: `onExtensionMessage` waits for a still-registering extension instead of
    refusing it outright.** A genuine page of an extension whose `session.extensions.loadExtension()`
    is already in flight can call a `crx-msg` handler (a real extension's own popup script calling
    a chrome.\* API as its first statement, before any user interaction, wins this exact race every
    time) before `eventSessionExtensions.getExtension(id)` reflects that load -- previously an
    immediate `"...was sent from an unknown extension context"` throw. `waitForRegisteredExtension`
    now waits up to `EXTENSION_REGISTRATION_WAIT_MS` (2s) for `'extension-loaded'` to name the same
    id before giving up and refusing as before. Safe to wait rather than refuse: `extensionId` only
    ever reaches this method non-`undefined` by way of `onRouterMessage`, which already refused the
    call outright if `gMessageSenderIdCheck` was set and did not confirm `extensionId` names THIS
    sender's own origin -- so an unrelated page has no way to reach this wait by naming an id that
    is not its own, only the genuine owner gets the grace period.
37. **A page declared in the extension's own manifest `sandbox.pages` gets no `chrome.*` at all,
    the way real Chrome's CSP `sandbox` directive gives it none -- fixed at both ends.**
    Measured directly (a real sandbox.html document, a fixture with every permission this
    library implements): before this patch it got 15 full `chrome.*` namespaces (`tabs`,
    `storage`, `cookies`, `declarativeNetRequest`, `windows`, ...), including a working
    `chrome.tabs.query` -- extensions put untrusted code (templates, `eval`) in a sandboxed page
    specifically because it cannot reach extension APIs. `src/preload.ts`: before calling
    `injectExtensionAPIs()`, asks main synchronously (`ipcRenderer.sendSync`, a new
    `orivon-extensions:sandbox-page-query` channel -- `src/main/channels.ts`'s own
    `EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL` doc says why the literal is duplicated rather than
    imported) whether THIS frame is one of its own extension's declared `sandbox.pages`; main
    answers from `event.senderFrame`'s own URL and the extension's REAL loaded manifest, never
    from anything the query itself could pass. Also checks `self.origin === 'null'` (opaque)
    first, cheaper and needing no round trip -- `self.origin`, not `location.origin`, which
    stays the ordinary `chrome-extension://<id>` string on this Electron build even for a
    genuinely CSP-sandboxed document (measured). `router.ts`'s `onExtensionMessage` refuses
    independently, on every message, from the SAME two signals read off `event.senderFrame` and
    the extension's own resolved manifest (`isSandboxPageUrl`, a new exported matcher using
    Chrome's own `sandbox.pages` glob grammar, `*` matching any run of characters) -- defense in
    depth: even a `crx-msg` that somehow reached the router without going through the preload's
    own gate is refused the same way. Measured after: `chrome.tabs` is `undefined` in the
    sandboxed page, and a direct `chrome.tabs.query` attempt never reaches a real call. Neither
    check's own opaque-origin branch actually had anything to fire from until patch 40 below
    served these pages the CSP that makes an origin opaque at all on this Electron build; each
    still refuses on the manifest's own `sandbox.pages` list alone in the meantime, which needs
    no origin support.
38. **`router.ts`: the registration-race wait (patch 36) also covers `crx-add-listener`, and is
    shared per extension id instead of one wait per call.** `onAddListener` used to call
    `observer.addListener(...)` synchronously and directly; a page whose extension was still
    registering hit the exact same race `onRouterMessage`'s own crx-msg path does (a popup's own
    top-level `chrome.runtime.onMessage.addListener()` call, before `session.extensions`
    reflects the load already in flight) and lost the subscription for good, since
    `addListener` throws synchronously for an unregistered id and the surrounding `ipcMain.on`
    handler is fire-and-forget. Now resolved in the same tick when the extension is already
    registered (the common case), and deferred to `waitForRegisteredExtension` only on an actual
    race. `waitForRegisteredExtension` itself now shares ONE pending wait, one
    `'extension-loaded'` listener and one timer, per `(extensions, extensionId)`
    (`pendingRegistrations`, a `WeakMap<extensions, Map<extensionId, Promise>>`) -- a stale page
    of a disabled or reloading extension previously paid the full 2s wait, and added a new
    listener, on every call it ever made; concurrent callers racing the same extension id (a
    crx-msg and one or more crx-add-listener calls, all from the same still-loading extension)
    now await the identical promise instead.
39. **`isSandboxPageUrl`: a linear-time glob match, replacing a backtracking regex built from
    the extension's own manifest; normalised the way Chromium normalises before comparing.**
    The regex this replaced (`pattern.split('*').map(escapeRegExp).join('.*')`, anchored)
    is correct but a pattern with several `*`s is the textbook catastrophic-backtracking shape,
    and this runs synchronously on the main thread, on every page load and every `crx-msg` --
    measured: `'a*'.repeat(8) + 'b'` against a 40-character near-miss string already took over a
    second with the old regex; the new matcher (`matchesGlob`: split on `*`, `indexOf` each
    literal piece in order, anchored ends) resolves a 5000-character version in under a
    millisecond, however many stars the pattern has -- no cap on the star count is needed, since
    the matcher's own bound already covers it (patch 41 drops the separate star cap). Also
    normalises both sides the way Chromium does: a manifest `sandbox.pages` entry's own leading
    `/` is stripped (Chrome accepts `"/sandbox.html"` and `"sandbox.html"` as the same
    declaration), and the URL's pathname is percent-decoded (`%2E` and `.` name the same file)
    before comparison; a pathname that fails to decode matches nothing, rather than being
    compared still encoded.
40. **A manifest `sandbox.pages` document is now actually served with Chrome's own CSP
    `sandbox` directive, giving it a genuinely opaque origin -- the real fix behind patch 37's
    own opaque-origin checks.** New `src/main/extensions/extension-sandbox-csp.ts`, registered
    through `../sessions/web-request-owner.ts` (never `session.webRequest` directly). Reason
    (`docs/decisions/resolved-questions.md` A302): patch 37 alone stops a `chrome.*` binding from being
    injected into the sandboxed page itself, but Electron still serves it at its extension's own
    `chrome-extension://<id>` origin -- measured, this let a sandboxed iframe framed by an
    ordinary extension page reach `parent.chrome` and `parent.document` directly (same-origin,
    no restriction at all), a complete bypass. `webRequestOwnerFor(session.defaultSession)
    .onHeadersReceived` DOES fire for a `chrome-extension:` response in the default session --
    measured directly, not assumed. The handler appends Chrome's own default sandbox CSP
    (`sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self'
    'unsafe-inline' 'unsafe-eval'; child-src 'self';`, no `allow-same-origin`) to a document
    response (`mainFrame`/`subFrame` only -- CSP `sandbox` is meaningless on a subresource
    fetch) whose URL matches the extension's own `isSandboxPageUrl`, or the manifest's own
    `content_security_policy.sandbox` string when the manifest sets one. Measured after: the
    sandboxed page's `self.origin` reads the literal string `"null"` (real Chrome's own
    behaviour) -- `location.origin` still does not, on this Electron build, which is why
    patch 37's own checks read `self.origin`; a framed sandboxed iframe's `parent.chrome` and
    `parent.document` both throw `Blocked a frame with origin "null" from accessing a
    cross-origin frame`, closing the bypass; and `chrome.storage`/`chrome.runtime.connect`
    (Electron's own native bindings, unaffected by patch 37's JS-injection-only fix) are also
    unusable there now.
41. **`isSandboxPageUrl` strips ALL leading `/` and `\`, not just the first, and matches
    case-insensitively on win32/darwin; the page-count and star caps are gone.** Real Chromium's
    `ExtensionURLToRelativeFilePath` strips every leading `/`/`\` before resolving the on-disk
    file, so `chrome-extension://<id>//sandbox.html` (a doubled leading slash) still serves the
    real `sandbox.html` -- measured directly, on Linux, through a framed iframe whose `src` never
    goes through `extension-url-policy.ts`'s own tab-open gate. Stripping only the first
    separator (patch 39) left the compared pathname with one still attached, silently missing
    every such request: no CSP, no router refusal, `chrome.*` injected in full. A literal
    backslash is measured to become a second forward slash under Chromium's own URL parsing for
    this scheme, so it resolves to the identical case; a `"/./"` segment is already collapsed by
    the URL parser itself (WHATWG dot-segment removal) before this function ever sees it, so it
    was never a distinct case. On win32/darwin, whose filesystems resolve "SANDBOX.html" and
    "sandbox.html" to the same file, the match is now case-insensitive too (`platform` param,
    default `process.platform`); Linux stays case-sensitive, matching what its filesystem
    actually serves (measured: a differently-cased request 404s there instead of reaching the
    real file). Both of patch 39's own caps are removed rather than fixed: they failed open (the
    201st declared page, or a pattern past 8 stars, was silently treated as NOT a sandbox page
    at all, the opposite of refusing) and the star cap was never needed in the first place (the
    matcher is linear regardless of star count). The page-count limit moves to
    `src/broker/policy/extension-manifest.ts`'s own `MAX_SANDBOX_PAGES`, which refuses to load a
    manifest over the cap entirely, so `isSandboxPageUrl` itself never needs to skip anything a
    real session's manifest declares. A residual, not fixed by this patch: `chrome.tabs.query`
    still answers real data for the doubled-leading-slash URL despite every check in this fork
    correctly refusing it (`docs/open-questions.md` A303) -- filed open, not asserted away.
42. **`router.ts`: a `crx-remove-listener` arriving while its own `crx-add-listener` is still
    deferred (patch 38's registration-race wait) now cancels the deferred add, instead of the
    listener coming back once the wait resolves.** `onAddListener` used to call
    `observer.addListener(...)` unconditionally once its wait settled; a `crx-remove-listener`
    for the identical subscription that arrived DURING that wait found nothing yet added (a
    silent no-op) and the deferred add then ran anyway, re-adding a subscription the caller had
    already asked removed. `pendingListenerAdds` (a `WeakMap<extensions, Map<listenerKey,
    symbol>>`, keyed the same way `pendingRegistrations` is) tracks one token per still-deferred
    add; `onRemoveListener` deletes the matching token before falling through to the real
    `removeListener` call, and the deferred add checks its own token is still current before
    calling `addListener` at all.

43. **`getRouter()` on `ElectronChromeExtensions`, and a permission-check override on the
    router.** `src/browser/index.ts`: added a public `getRouter(): ExtensionRouter` returning the
    private `ctx.router` this library's own API classes (`src/browser/api/*.ts`) already register
    their handlers on. `src/browser/router.ts`: added `setPermissionCheck` (same module-level-
    setter shape as patches 5/9's sender checks), which `onExtensionMessage` calls instead of
    reading the loaded extension's own `manifest.permissions` when a handler's `permission` check
    runs, if set. Reason: Orivon's own `declarativeNetRequest` API handlers
    (`src/main/extensions/dnr-api.ts`) register on this same router, the same way this library's
    own API classes do, so the renderer's `invokeExtension('declarativeNetRequest.<method>')`
    calls (patch 10) reach real main-side code through the same `crx-msg` path every other API
    uses; and Orivon strips every `declarativeNetRequest*` permission from the manifest copy it
    loads (`src/main/extensions/README.md`), so gating those handlers on the loaded manifest's own
    permissions would always refuse -- `setPermissionCheck`'s override answers from the ORIGINAL
    permission record Orivon kept instead (`registry.ts`'s `StrippedRecord`).
44. **`setBadgeText()` on `ElectronChromeExtensions`, set from main.** `src/browser/api/
    browser-action.ts`: added a public `BrowserActionAPI.setBadgeTextFromMain(extensionId, tabId,
    text)`, the same tab-scoped `action.tabs[tabId].text` write and `onUpdate()` broadcast
    `setDetails`'s `browserAction.setBadgeText` IPC handler already does for an extension calling
    the API on itself, minus the `ExtensionEvent`/default-value lookup that path needs and this
    caller does not (it always passes an explicit string). `src/browser/index.ts`: added a public
    `setBadgeText(extensionId, tabId, text)` delegating to it. Reason: Orivon's own
    `declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true })`
    wiring (`src/main/extensions/dnr-api.ts`) renders a per-tab matched-rule count driven by
    `webRequest`, from main, never from the extension's own script -- there was no public way in
    for a caller outside this library's own IPC handlers to set one tab's badge text.
45. **The renderer seam: extras, `__crx`, strict calls, `devtools_page`.**
    `src/renderer/index.ts`: `injectExtensionAPIs(extras = [])`. `mainWorldScript` no longer ends
    by deleting `electron` and freezing `chrome`; that tail is a second self-contained function,
    `finalizeScript`, which runs after every extra. The order is `mainWorldScript`, each extra
    through `contextBridge.executeInMainWorld({ func })` (one at a time, so a throwing extra does
    not stop the others or leave the page unlocked), then `finalizeScript`. Between them
    `globalThis.__crx` (a configurable property, deleted by `finalizeScript`) carries what an extra
    needs: `extensionId`, `manifest`, `context` (`'worker'` or `'page'`), `declares(permission)`
    (the manifest lists it under `permissions` or `optional_permissions`), `call(name)` (an
    `invokeExtension` with the new `strict` option), `event(name)` (an `ExtensionEvent`) and
    `define(ns, build)` (the library's own `Object.defineProperty(chrome, ns, ...)`, with
    Electron's native object of that name as `base`). `ExtensionMessageOptions.strict`: an IPC
    error rethrows with the `Error invoking remote method 'crx-msg': Error: ` prefix removed, so a
    handler's own message reaches the caller; with a trailing callback the error is logged and the
    callback gets `undefined`, as before. Every library namespace keeps the old swallow-and-resolve
    behaviour. `finalizeScript` leaves `chrome` unfrozen in the document of the manifest's own
    `devtools_page`: Electron attaches `chrome.devtools` after this preload ran, and a frozen
    `chrome` made that attach fail (measured: with the freeze skipped, `devtools.panels.create`
    calls back). New `src/renderer/extras.ts` holds the list (`setExtraMainWorldApis`,
    `getExtraMainWorldApis`); `src/preload.ts` passes it to `injectExtensionAPIs`. Reason: the
    namespaces Orivon adds are written once, in `src/preload/extension-apis/`, instead of as more
    blocks in this file.
46. **Toolbar actions from main.** `src/browser/api/browser-action.ts`: public
    `listActions()` (id, title, whether a popup is set), `activateFromMain(extensionId, tab, anchor)`
    (the existing `activateClick` with `recordInvocation: true`, for Orivon's own trusted code: a
    menu entry or a shortcut; no extension message reaches it) and `notifyChanged()` (the private
    `onUpdate`). Module setters, set once before the first activation: `setActionVisibilityCheck`
    filters the actions `getState` and `listActions` report (unset: all of them), and
    `setActionClickInterceptor`, called in `activateClick` after the invocation is recorded and
    before any popup opens; `true` means the click was handled elsewhere (a side panel, an
    omnibox), so no popup and no `onClicked`. `src/browser/index.ts` exposes the three methods as
    `listActions`, `activateAction` and `notifyActionsChanged`. Reason: Orivon's own toolbar menu
    lists and clicks actions, and pinning hides some, none of which the chrome view's
    `<browser-action-list>` channel can do on Orivon's behalf.
47. **Host-access checks receive the extension id.** `src/browser/api/cookies.ts` and
    `src/browser/api/tabs.ts`: `setCookieHostAccessCheck`, `setTabUrlAccessCheck` and
    `setTabHostAccessCheck` now call `check(manifest, url, extensionId, tabId?)`; `tabId` is passed
    where the answer is about one tab (`filterTabDetails` reads `details.id`, `insertCSS` the
    tab's id). Reason: a host decision that depends on more than the manifest (a per-extension
    site-access choice, a one-tab grant) needs to know which extension asks and about which tab.
50. **The toolbar action's right-click menu is Orivon's.** `src/browser/api/browser-action.ts`:
    module setter `setActionMenuBuilder(builder)`; `activateContextMenu` builds its template from
    `builder(extensionId, extensionItems)` (the extension's own `contextMenus` entries for
    `browser_action` are passed in for the builder to place) and pops it up at the same spot; with no
    builder set the library's own menu is unchanged. Reason: the menu's labels, its pin entry and
    what each item opens are Orivon's.
51. **Every action, pinned or not.** `src/browser/api/browser-action.ts` and `src/browser/index.ts`:
    `listAllActions(tabId?)` returns `{ id, title, hasPopup, badge }` for every extension that has an
    action, whatever `setActionVisibilityCheck` says (`listActions` leaves the hidden ones out); the
    title, popup and badge are the ones set for `tabId` when there are any, else the action's own.
    Reason: Orivon's Extensions menu lists unpinned extensions too, shows their badge and runs them.
56. **`requestPermissions` refuses when the host gives no prompt.** `src/browser/store.ts`:
    `requestPermissions` returns `false`, was `true`, when `impl.requestPermissions` is not a
    function. Reason: the default granted every `chrome.permissions.request` unasked, so a host that
    never wired its own prompt silently widened every extension. Orivon's `permissions` module
    replaces the handler and asks; this default is only the safe fallback.

`partition.ts` is reached only through the virtual specifier `src/main/extensions/
electron-chrome-extensions-lib.d.ts` declares, never its real path -- that file's own header, and
`src/main/extensions/README.md`'s Design notes, say why. Its own diagnostics under the root
tsconfig (verbatimModuleSyntax, exactOptionalPropertyTypes) are therefore not patched: nothing in
`src/` opens it directly, and `vendor/tsconfig.json`'s own, looser check already covers it as
authored. `browser/index.ts`, `router.ts`, `api/cookies.ts`, `api/tabs.ts`, `api/web-navigation.ts`,
`api/windows.ts`, `store.ts`, `api/browser-action.ts`, `popup.ts` and `api/notifications.ts` are
the exceptions: patches 13-14, 16-20 and 21-31 above make them satisfy the root tsconfig too, so
`src/main/extensions/tests/` can unit-test the sender-id, permission and host-access patches
directly against the real files, instead of only against a same-shaped local fake. `context.ts`
and `api/common.ts`/`impl.ts` sit on the same import path and needed no patch of their own: measured,
`npx tsc --noEmit -p tsconfig.json` reports nothing for any of them as authored.

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|winreg\|spawn(" vendor/electron-chrome-extensions/src` returns nothing.
