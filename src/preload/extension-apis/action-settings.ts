import type { Crx } from './crx.js'

/** `chrome.action.onUserSettingsChanged`: main tells an extension when its pin on the toolbar changes. */
export function actionSettingsApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  // The same condition the library defines `chrome.action` under, so this never makes a namespace of its own.
  const manifest = crx.manifest as { manifest_version?: number, action?: unknown }
  if (manifest.manifest_version !== 3 || !manifest.action) return
  crx.define('action', (base) => ({ ...base, onUserSettingsChanged: crx.event('action.onUserSettingsChanged') }))
}
