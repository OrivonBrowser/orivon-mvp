# ADR-0081: Windows builds also ship to the Microsoft Store as an MSIX package

- **Status:** accepted
- **Date:** 2026-10-13
- **Type:** product
- **Decided by:** owner

## Decision
Each release's Windows build also produces a Microsoft Store package (AppX, accepted by Partner Center as an MSIX
package), built by the same `electron-builder` run as the NSIS installer. The installer stays exactly as it is and
stays the only Windows file attached to a GitHub release. The Store package is kept as the workflow artifact
`store-msix` for the owner to upload in Partner Center; the Store signs it, so no certificate is bought.

## Context
The unsigned installer makes Windows show "Windows protected your PC" (SmartScreen) on first run, which is the first
thing a person trying Orivon on Windows sees. [`packaging.md`](../development/packaging.md) section Windows and macOS
has the workaround and `docs/known-limitations.md` names the warning.

## Alternatives considered
- **Sign the installer with a purchased code-signing certificate.** A new certificate has no SmartScreen reputation,
  and an extended-validation certificate no longer bypasses that: reputation builds over weeks of downloads of the
  same signed file, so the warning stays for the people who matter most, the first ones. A new certificate also means
  a secret in CI.
- **Microsoft Artifact Signing (Microsoft's hosted signing service).** It issues public-trust certificates to
  individual developers only in the United States and Canada, and to organizations that have been validated. Neither
  holds for this project today.
- **Leave the warning and document the workaround.** What the project did until now. It costs every new Windows
  person a screen that reads as "this may be malware".

## Reasoning
Every new unsigned `.exe` hash starts with no reputation, and a bought certificate starts with none either. A Store
install is signed by Microsoft and is never warned, with no certificate to buy, hold or rotate. The Store package is
an addition: the installer, the release assets and the release's IPFS folder are unchanged, so nobody who uses
either today notices.

## Consequences
- **Store policies now bind the product.** A browser must stay within two major versions of the current Chromium, so
  an Electron update is a standing duty, not an occasional one. The listing must say that Orivon runs third-party
  applications. Updates reach a Store install only through the Store, so a Store build neither looks for updates nor
  sends a person to GitHub for one (`src/main/os/windows-store.ts`, `src/main/self-update/`).
- **The install model differs.** The installer is per user into `%LOCALAPPDATA%\Programs\Orivon`; the package runs
  from a folder Windows owns, with its own package identity, and registers as a handler for http, https and five
  document types through its manifest (`build/appx-extensions.xml` and `protocols`), not through the registry.
  Which parts of the shell integration work there is unmeasured (A410).
- **Identity comes from Partner Center.** `appx.identityName`, `appx.publisher` and `appx.publisherDisplayName` in
  `electron-builder.yml` are placeholders until the owner reserves the name; the Store refuses a package whose
  identity differs from the reserved one.
- The first submission is made by hand ([`release-checklist.md`](../development/release-checklist.md)). Automating
  later submissions needs a Partner Center service principal in CI, which this decision does not add.
- The release workflow installs the package on a Windows runner with a throwaway certificate and launches it with its
  package identity, so a package that does not start fails the release job.

## Reversibility
- **Cost to reverse:** cheap. Remove the `appx` target and block, `build/appx/`, `build/appx-extensions.xml` and the
  workflow steps; the runtime changes only act when `process.windowsStore` is true.
- **What would make us revisit:** the Store refusing the listing (a browser that runs third-party apps), Microsoft
  Artifact Signing or a certificate becoming obtainable and reputation-free, or a Chromium-currency duty the project
  cannot keep.
