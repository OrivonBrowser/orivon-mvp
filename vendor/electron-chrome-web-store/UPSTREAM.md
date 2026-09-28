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

Nothing else changed; upstream code is not reformatted.

## Native-code check

`grep -rn "child_process\|spawn(\|execFile\|exec(" vendor/electron-chrome-web-store/src` returns
nothing; upstream never shelled out here.
