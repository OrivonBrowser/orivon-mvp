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
export interface UpdateCheckResult {
  extensionId: string
  from: string
  to?: string
  checkedAt: number
  error?: string
}

export interface WebStoreState {
  session: Electron.Session
  extensionsPath: string
  installing: Set<ExtensionId>
  allowlist?: Set<ExtensionId>
  denylist?: Set<ExtensionId>
  minimumManifestVersion: number
  beforeInstall?: BeforeInstall
  verifyCrx: VerifyCrx
  onUpdateCheck?: (result: UpdateCheckResult) => void
}
