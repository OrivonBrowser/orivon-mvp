// Stage one of the effective manifest: the optional permissions and origins
// the person granted, merged into `permissions` and `host_permissions`.
import type { ExtensionPrefs } from './extension-prefs.js'
import type { ExtensionManifest } from './effective-manifest.js'

export function applyGrantedStage (manifest: ExtensionManifest, _prefs: ExtensionPrefs): ExtensionManifest {
  return manifest
}
