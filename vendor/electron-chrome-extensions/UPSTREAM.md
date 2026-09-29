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
   `crx-msg` is unchanged: it is naturally scoped to a `chrome-extension:` page or service worker
   already (`src/preload.ts` only calls `injectExtensionAPIs()` there), and requires a
   `extensionId` registered in the calling session.
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

`src/browser/index.ts`, `partition.ts` and `router.ts` are reached only through the virtual
specifiers `src/main/extensions/electron-chrome-extensions-lib.d.ts` declares, never their real
path -- that file's own header, and `src/main/extensions/README.md`'s Design notes, say why. Their
own diagnostics under the root tsconfig (verbatimModuleSyntax, exactOptionalPropertyTypes) are
therefore not patched: nothing in `src/` opens those files directly, and `vendor/tsconfig.json`'s
own, looser check already covers them as authored.

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|winreg\|spawn(" vendor/electron-chrome-extensions/src` returns nothing.
