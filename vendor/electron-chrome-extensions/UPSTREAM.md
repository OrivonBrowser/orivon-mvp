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
9. **`crx-msg` sender-id check.** `src/browser/router.ts`: added `setMessageSenderIdCheck(check)`
   and an optional module-level predicate, checked in `onRouterMessage` before a message reaches
   `onExtensionMessage`. Reason: `onExtensionMessage`'s permission checks trust the `extensionId`
   argument the message itself carries, which a page or worker of one loaded extension can set to
   any other loaded extension's id by calling `window.electron.invokeExtension` directly, not only
   through the generated `chrome.*` wrappers. Orivon wires this to derive the real id from the
   sender's own `chrome-extension://<id>/` URL (`src/main/extensions/extension-sender-id-check.ts`)
   and refuse a mismatch -- `crx-msg-remote` already had an equivalent check (patch 5); this is
   its `crx-msg` counterpart.
10. **`declarativeNetRequest`, `sidePanel`, `userScripts`, and the rest of `webRequest`.**
    `src/renderer/index.ts`'s `apiDefinitions`: added factories for all four, following the
    file's own existing pattern (a `webRequest.onHeadersReceived`-only stub was already there).
    Reason: entirely absent otherwise, so an extension whose startup code calls or feature-
    detects any of them throws before it does anything else. `declarativeNetRequest`'s write
    methods reject "not supported"; its read methods resolve empty; `onRuleMatchedDebug` is an
    `ExtensionEvent` that never fires (nothing in this session ever calls its `sendEvent`).
    `sidePanel` and `userScripts` resolve as no-ops. None of this enforces anything: no dynamic-
    rule store, no real side panel, no real user script world -- a later package's own real
    engine, per docs/planning/extensions-build-plan.md's measurement section.
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

`src/browser/index.ts`, `partition.ts` and `router.ts` are reached only through the virtual
specifiers `src/main/extensions/electron-chrome-extensions-lib.d.ts` declares, never their real
path -- that file's own header, and `src/main/extensions/README.md`'s Design notes, say why. Their
own diagnostics under the root tsconfig (verbatimModuleSyntax, exactOptionalPropertyTypes) are
therefore not patched: nothing in `src/` opens those files directly, and `vendor/tsconfig.json`'s
own, looser check already covers them as authored.

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|winreg\|spawn(" vendor/electron-chrome-extensions/src` returns nothing.
