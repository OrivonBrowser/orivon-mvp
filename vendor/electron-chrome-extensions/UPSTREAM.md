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

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|winreg\|spawn(" vendor/electron-chrome-extensions/src` returns nothing.
