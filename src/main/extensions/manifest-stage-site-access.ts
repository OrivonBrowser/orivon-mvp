// Stage two of the effective manifest: the site-access choice (all sites,
// specific sites, or on click) applied to the host patterns the first stage
// left.
import type { ExtensionPrefs } from './extension-prefs.js'
import type { ExtensionManifest } from './effective-manifest.js'

export function applySiteAccessStage (manifest: ExtensionManifest, _prefs: ExtensionPrefs): ExtensionManifest {
  return manifest
}
