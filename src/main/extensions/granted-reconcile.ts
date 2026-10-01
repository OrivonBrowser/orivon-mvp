// After an install or an update writes a manifest, the grants must still fit
// it: an item the new manifest requires needs no grant, and one it stopped
// declaring is revoked.
import type { ExtensionPrefsStore } from './extension-prefs.js'
import { reconcileGranted } from './optional-permissions.js'

export function reconcileGrants (prefs: ExtensionPrefsStore, id: string, manifest: Readonly<Record<string, unknown>>): void {
  const before = prefs.get(id).granted
  if (before.permissions.length === 0 && before.origins.length === 0) return
  prefs.update(id, { granted: reconcileGranted(manifest, before) })
}
