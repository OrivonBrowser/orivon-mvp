# Upstream

- Source: https://github.com/samuelmaddock/electron-browser-shell, `packages/electron-chrome-extensions/`
- Commit: `354b0b8192e8c2d960e50cf108b5dbbb70448fec`
- Date: 2026-09-01
- License: GPL-3.0 (see `LICENSE.md`, `LICENSE-GPL`, `LICENSE-PATRON.md`), combinable with
  Orivon's AGPL-3.0-only under GPLv3 §13
- Vendored from: `packages/electron-chrome-extensions/src/` (no `spec/`, no build output)

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
    `declarativeNetRequest` is real, wired by patch 15 below to Orivon's own engine
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

15. **`getRouter()` on `ElectronChromeExtensions`, and a permission-check override on the
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

`src/browser/index.ts` and `partition.ts` are reached only through the virtual specifiers
`src/main/extensions/electron-chrome-extensions-lib.d.ts` declares, never their real path -- that
file's own header, and `src/main/extensions/README.md`'s Design notes, say why. Their own
diagnostics under the root tsconfig (verbatimModuleSyntax, exactOptionalPropertyTypes) are
therefore not patched: nothing in `src/` opens those files directly, and `vendor/tsconfig.json`'s
own, looser check already covers them as authored. `router.ts`, `api/cookies.ts`, `api/tabs.ts`,
`api/web-navigation.ts`, `api/windows.ts` and `store.ts` are the exceptions: patches 13-14 and
16-20 above make them satisfy the root tsconfig too, so `src/main/extensions/tests/` can
unit-test the sender-id, permission and host-access patches directly against the real files,
instead of only against a same-shaped local fake. `context.ts`, `api/common.ts` and `impl.ts` sit
on the same import path and needed no such patch: measured, `npx tsc --noEmit -p tsconfig.json`
reports nothing for them as authored.

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|winreg\|spawn(" vendor/electron-chrome-extensions/src` returns nothing.
