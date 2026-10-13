// The person's extensions in a profile session (`../route/site-partition.ts`): every extension loaded in the default
// session is loaded in the profile session too, once, and follows the default session's loading and unloading from then on,
// so a hundred websites in a profile cost one copy of each extension and not a hundred.
//
// What a profile session gets is what Electron's own per-session extension support gives: the extension's content scripts,
// its background page or service worker, and `chrome.runtime`/`chrome.storage` of its own. The browser-level APIs
// (`chrome.tabs`, `chrome.windows`, the toolbar button and popup, `declarativeNetRequest` rules, the
// webRequest-backed blockers) are the default session's: the library that provides them is bound to one session.
// Tied to Electron.
import type { Session } from 'electron'

/** Loads the extensions of `source` into `target`, and keeps them in step. Never throws: what cannot be loaded is logged. */
export async function mirrorExtensions (target: Session, source: Session): Promise<void> {
  const load = async (path: string, name: string): Promise<void> => {
    try {
      // Never allowFileAccess: true -- extensions never get file:// access (README.md's Design notes).
      await target.extensions.loadExtension(path, { allowFileAccess: false })
    } catch (error) {
      console.error(`[extensions] could not load ${name} into a profile session: ${String(error)}`)
    }
  }
  source.extensions.on('extension-loaded', (_event, extension) => { void load(extension.path, extension.name) })
  source.extensions.on('extension-unloaded', (_event, extension) => {
    try {
      target.extensions.removeExtension(extension.id)
    } catch (error) {
      console.error(`[extensions] could not remove ${extension.name} from a profile session: ${String(error)}`)
    }
  })
  for (const extension of source.extensions.getAllExtensions()) await load(extension.path, extension.name)
}
