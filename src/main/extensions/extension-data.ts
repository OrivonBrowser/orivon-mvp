// What an extension leaves behind besides its own folder: its web storage (localStorage, IndexedDB,
// caches, service worker) and the stores behind chrome.storage. Removing the extension empties both,
// as Chrome does, so installing it again starts clean.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from 'electron'
import type { InstallContext } from './install-runner.js'

const EXTENSION_ID = /^[a-p]{32}$/

/** The folders under a session's own that hold an extension's `chrome.storage`: they are emptied through the extension's own origin while it is loaded, and removed from disk when it is not. */
const SETTINGS_FOLDERS = ['Local Extension Settings', 'Sync Extension Settings']

/** Run while the extension is still loaded: chrome.storage can only be emptied through its own origin. */
export async function deleteExtensionData (ctx: InstallContext, id: string): Promise<void> {
  if (!EXTENSION_ID.test(id)) return
  const origin = `chrome-extension://${id}`
  // The default session, then each profile session: a copy loaded there is emptied through its own origin, and one that is not
  // loaded (the direct profile's, with no website open) has its settings folders removed from disk, since nothing can reach them.
  const sessions = [ctx.session, ...(ctx.profileSessions?.() ?? [])]
  for (const target of sessions) {
    const loaded = target === ctx.session || target.extensions.getExtension(id) != null
    try {
      if (loaded) await ctx.clearExtensionStorage?.(id, target)
    } catch {
      // No chrome.storage to empty: the extension holds no `storage` permission, or its page would not open.
    }
    try {
      await target.clearStorageData({ origin })
    } catch (error) {
      console.error(`[extensions] could not clear the web storage of ${id}:`, error)
    }
    if (!loaded) removeSettingsFolders(target, id)
  }
}

function removeSettingsFolders (target: Session, id: string): void {
  try {
    const root = target.getStoragePath()
    if (root === null) return
    for (const folder of SETTINGS_FOLDERS) rmSync(join(root, folder, id), { recursive: true, force: true })
  } catch (error) {
    console.error(`[extensions] could not remove the settings of ${id} from a profile:`, error)
  }
}
