// Orivon patch: this file's `chrome.runtime.Manifest` needs `@types/chrome`'s
// global namespace, which the root tsconfig's `types` array leaves out on
// purpose (it would otherwise leak into every ordinary Orivon file). An
// explicit reference here pulls it in for this file's own program slice
// without changing that root setting -- UPSTREAM.md patch 6.
/// <reference types="chrome" />

export type ExtensionId = Electron.Extension['id']

export interface ExtensionInstallDetails {
  id: string
  localizedName: string
  manifest: chrome.runtime.Manifest
  icon: Electron.NativeImage
  browserWindow?: Electron.BrowserWindow
  frame: Electron.WebFrameMain
}

export type BeforeInstall = (
  details: ExtensionInstallDetails,
) => Promise<{ action: 'allow' | 'deny' }>

// Orivon patch: Orivon verifies CRX3 signatures itself; every path that
// unpacks downloaded CRX bytes must call this first and fail closed if it throws.
export type VerifyCrx = (crx: Buffer, expectedId: string) => void | Promise<void>

// Orivon patch: reported once per extension per update check (see updater.ts).
// `to`/`error` are `T | undefined`, not `T?`: every caller builds this with
// both keys always present (root tsconfig's exactOptionalPropertyTypes
// treats those as different shapes -- an omitted key vs. one holding
// `undefined`).
export interface UpdateCheckResult {
  extensionId: string
  from: string
  to: string | undefined
  checkedAt: number
  error: string | undefined
}

// Orivon patch: when present, every install, update and uninstall routes
// through this instead of the library's own filesystem/loadExtension calls
// (UPSTREAM.md patch 4) -- Orivon writes and loads every extension copy
// itself. `downloadUrl` on installCrx is the CRX's own download URL, passed
// through so Orivon can record it against a held-back update (its own
// consent gate, not this library's concern).
export interface WebStoreHost {
  installCrx: (crx: Buffer, expectedId: string, approvedManifest?: string, downloadUrl?: string) => Promise<void>
  uninstall: (id: string) => Promise<void>
  /** Where to download `id`'s CRX from instead of the store's own URL; `undefined` keeps it. */
  crxUrl?: ((id: string) => string | undefined) | undefined
}

// Orivon patch: every optional field below is `T | undefined`, not `T?` --
// index.ts's own installChromeWebStore always builds this object with every
// key present, some of them possibly `undefined` (same
// exactOptionalPropertyTypes reasoning as UpdateCheckResult above).
export interface WebStoreState {
  session: Electron.Session
  extensionsPath: string
  installing: Set<ExtensionId>
  allowlist: Set<ExtensionId> | undefined
  denylist: Set<ExtensionId> | undefined
  minimumManifestVersion: number
  beforeInstall: BeforeInstall | undefined
  verifyCrx: VerifyCrx
  onUpdateCheck: ((result: UpdateCheckResult) => void) | undefined
  host: WebStoreHost | undefined
}
