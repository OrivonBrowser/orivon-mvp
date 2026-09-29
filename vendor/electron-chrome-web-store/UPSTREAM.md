# Upstream

- Source: https://github.com/samuelmaddock/electron-browser-shell, `packages/electron-chrome-web-store/`
- Commit: `354b0b8192e8c2d960e50cf108b5dbbb70448fec`
- Date: 2026-09-01
- License: MIT, as the package's `package.json` declares (`"license": "MIT"`, author Samuel
  Maddock). Upstream ships no package-local licence file, so `LICENSE.md` here is the standard
  MIT text with that author. The monorepo root's `LICENSE` is GPL-3.0; under either licence the
  code combines with Orivon's AGPL-3.0-only.
- Vendored from: `packages/electron-chrome-web-store/src/` (no build output)

## Patches

1. **Mandatory CRX verifier.** `src/browser/types.ts`: added `VerifyCrx = (crx: Buffer,
   expectedId: string) => void | Promise<void>` and made `WebStoreState.verifyCrx` required.
   `src/browser/index.ts`: `verifyCrx` is now a required field of `installChromeWebStoreOptions`
   and flows into `WebStoreState`. `src/browser/installer.ts`: `downloadExtensionFromURL(url,
   extensionsDir, verifyCrx, expectedExtensionId?)` calls `verifyCrx(crxBuffer, extensionId)` on
   the raw downloaded bytes before `unpackCrx()` runs; `downloadExtension` and `installExtension`
   (its `InstallExtensionOptions.verifyCrx` is required) both take it too, since they can be
   called standalone without going through `installChromeWebStore`. `src/browser/updater.ts`:
   `updateExtension`/`installUpdates`/`updateExtensions`/`maybeCheckForUpdates`/`initUpdater` all
   thread `verifyCrx` down to the same `downloadExtensionFromURL` call, so an update is verified
   before it replaces the installed version. A throw fails the install/update and leaves the
   previous state (nothing written, or the prior version still loaded) untouched. Reason: Orivon
   verifies CRX3 signatures itself rather than trusting the Chrome Web Store's transport.
2. **Explicit preload path.** `src/browser/index.ts`: added `preloadPath?: string` to
   `ElectronChromeWebStoreOptions`; used instead of `resolvePreloadPath()` when given. Same
   reason as `electron-chrome-extensions`.
3. **Observable update checks.** `src/browser/types.ts`: added `UpdateCheckResult` and
   `WebStoreState.onUpdateCheck?`. `src/browser/updater.ts`'s `checkForUpdates` now calls
   `onUpdateCheck` once per checked extension (from `installChromeWebStoreOptions.onUpdateCheck`),
   reporting `{ extensionId, from, to?, checkedAt, error? }` whether or not an update was found.
   `updateExtensions` (the standalone exported entry point, previously `(session?) => void`) and
   the internal chain down to it (`maybeCheckForUpdates`, `initUpdater`) now take `verifyCrx` and
   `onUpdateCheck` as well, since `updateExtensions` reaches `downloadExtensionFromURL` the same
   way the installer does and was the one download/unpack path patch 1 would otherwise miss.

4. **Orivon host hooks.** `src/browser/types.ts`: added `WebStoreHost` (`installCrx(crx,
   expectedId, approvedManifest?, downloadUrl?)`, `uninstall(id)`) and `WebStoreState.host?:
   WebStoreHost`. `src/browser/index.ts`: `host?: WebStoreHost` added to
   `ElectronChromeWebStoreOptions`, threaded into `WebStoreState`. `src/browser/installer.ts`:
   `downloadExtensionFromURL`'s download-and-parse-header step is factored into an exported
   `downloadCrxBytes(url)`, so a host branch and a non-host branch can share it without
   duplicating the temp-file dance; `downloadExtensionFromURL` still calls the required
   `verifyCrx` hook (patch 1) on every download either way, then -- when a `host` argument is
   given -- calls `host.installCrx(bytes, id, approvedManifest?, url)` and returns instead of
   unpacking to `extensionsDir` and loading it itself. `installExtension`'s host branch skips its
   own "already loaded"/"already installed" filesystem checks entirely (moot: Orivon loads into
   the same session this library reads, so `getExtensionInstallStatus` in `api.ts` already sees
   the right state without them) and returns `Electron.Extension | undefined` instead of always
   an `Extension`, since a host install never hands one back. `uninstallExtension`'s host branch
   calls `host.uninstall(id)` instead of its own `removeExtension`/`rm`. `src/browser/updater.ts`:
   `updateExtension`'s host branch calls `downloadExtensionFromURL` with `host` and the currently
   loaded extension's own manifest as `approvedManifest`, skipping the versioned-directory-name
   check and the old-folder cleanup below it (a host's own directory layout, not this library's,
   and a host's own `finishInstall`-equivalent already removes the previous version); `host` is
   threaded down through `installUpdates`, `updateExtensions` (its 4th parameter) and
   `maybeCheckForUpdates`/`initUpdater` (from `WebStoreState.host`) the same way `verifyCrx` and
   `onUpdateCheck` already were. Reason: `src/main/extensions/README.md`'s Design notes -- Orivon
   writes every loaded extension's copy itself (stripped permissions, a stable `key`) and must be
   the only thing that calls `loadExtension`; `listStoreInstalled` from an earlier draft of this
   host interface was dropped because nothing needs it -- every place this library would have
   asked it already reads `session.extensions.getAllExtensions()`/`getExtension()` directly, which
   already reflects what Orivon loaded, since host and library share one `session`.
5. **Exact origin, main frame only.** `src/browser/api.ts`: the IPC gate's
   `senderFrame.origin.startsWith(WEBSTORE_URL)` also accepts
   `https://chromewebstore.google.com.evil.com`; replaced with an exported `isWebStoreFrame(frame)`
   requiring `frame.origin === WEBSTORE_URL` (exact) and `frame.top === frame` (the call's own
   frame must be the top one, never an iframe on the real origin embedding something that
   forwards a call). `src/renderer/chrome-web-store.preload.ts`: the same shape,
   `location.href.startsWith(...)` replaced with `new URL(location.href).origin === ...` plus
   `window.top === window`, since this preload runs in every frame of every site (a `frame`-type
   preload) and must expose `chrome.webstorePrivate` in none of them except the store's own top
   frame. Reason: an origin check that accepts a prefix accepts an attacker's subdomain.
6. **TypeScript compatibility with the root tsconfig.** Nothing under `src/` imported this
   library until now (only `id.ts`, which needs none of this); wiring it in
   (`src/main/extensions/store-runner.ts`) pulls every file below into the root tsconfig's
   program for the first time, under its stricter settings than `vendor/tsconfig.json`'s own
   (the same reasoning `src/main/extensions/crx.ts`'s own doc gives for reimplementing the CRX3
   header reader rather than importing this library's `crx3.ts` -- that file is still not
   imported directly, only transitively through `installer.ts`, which this patch also makes
   typecheck). Four kinds of fix, all mechanical, no behaviour change:
   - **`verbatimModuleSyntax`**: every type-only import (`ExtensionId`, `WebStoreState`,
     `VerifyCrx`, `WebStoreHost`, `BeforeInstall`, `UpdateCheckResult`, and `electron`'s
     `NativeImage`/`Session`) becomes `import type` in `api.ts`, `index.ts`, `installer.ts`,
     `loader.ts` and `updater.ts`.
   - **The global `chrome` namespace**: `@types/chrome` is in `vendor/tsconfig.json`'s own
     `types` array but deliberately left out of the root one (it would otherwise leak into every
     ordinary Orivon file). `/// <reference types="chrome" />` at the top of `types.ts`, `api.ts`,
     `installer.ts`, `loader.ts` and `updater.ts` pulls it in for just this program slice, the
     standard way to reach an otherwise-excluded `@types/*` package for one file.
   - **`exactOptionalPropertyTypes`**: `types.ts`'s `WebStoreState` fields (`allowlist`,
     `denylist`, `beforeInstall`, `onUpdateCheck`, `host`) and `UpdateCheckResult`'s `to`/`error`
     become `T | undefined` rather than `T?` -- every construction site already builds these with
     every key present, sometimes holding `undefined`, which this flag treats as a different
     shape from an omitted key. `installer.ts`'s `InstallExtensionOptions.host` and
     `UninstallExtensionOptions.host` become `host?: WebStoreHost | undefined` (both optional AND
     explicit about `undefined`) for the same reason from the other direction: `api.ts` passes a
     whole `WebStoreState` as this options object, and only that combined shape accepts it.
     `api.ts`'s one `state.beforeInstall(...)` call omits `browserWindow` entirely instead of
     setting it to `undefined`, rather than widening `ExtensionInstallDetails` itself. `crx3.ts`'s
     `CrxFileHeader.verified_contents`/`signed_header_data` and `readSignedData`'s return type
     get the same `T | undefined` treatment as `WebStoreState`'s fields, for the same reason.
   - **`noUncheckedIndexedAccess`**: `utils.ts`'s `compareVersions` falls back to `?? 0` for a
     version string with fewer than three dot-separated parts (which should already compare as
     lower). `updater.ts`'s `fetchAvailableUpdates` asserts (`!`) an Omaha-response id names an
     extension this same function requested, matching the non-null assertions the surrounding
     code already makes for the rest of that response's shape.

7. **The approved manifest travels with a store-page install.** `src/browser/api.ts`'s
   `beginInstall` passes the manifest the store page showed the person (`details.manifest`)
   to `installExtension` as `approvedManifest`, and `src/browser/installer.ts` hands it to
   `host.installCrx` with the downloaded bytes. Reason: the host refuses a download whose
   manifest asks for more than the person approved.

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|spawn(\|execFile\|exec(" vendor/electron-chrome-web-store/src` returns
nothing; upstream never shelled out here.
