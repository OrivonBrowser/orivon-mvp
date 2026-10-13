// What an extension leaves behind besides its own folder: its web storage (localStorage, IndexedDB,
// caches, service worker) and the stores behind chrome.storage. Removing the extension empties both,
// as Chrome does, so installing it again starts clean.
import type { InstallContext } from './install-runner.js'

const EXTENSION_ID = /^[a-p]{32}$/

/** Run while the extension is still loaded: chrome.storage can only be emptied through its own origin. */
export async function deleteExtensionData (ctx: InstallContext, id: string): Promise<void> {
  if (!EXTENSION_ID.test(id)) return
  const origin = `chrome-extension://${id}`
  // The default session, then each profile session that holds a copy: a copy loaded there is emptied through its own
  // origin, one that is not loaded (the direct profile's, with no website open) has only its web storage to clear.
  const sessions = [ctx.session, ...(ctx.profileSessions?.() ?? [])]
  for (const target of sessions) {
    try {
      if (target === ctx.session || target.extensions.getExtension(id) != null) await ctx.clearExtensionStorage?.(id, target)
    } catch {
      // No chrome.storage to empty: the extension holds no `storage` permission, or its page would not open.
    }
    try {
      await target.clearStorageData({ origin })
    } catch (error) {
      console.error(`[extensions] could not clear the web storage of ${id}:`, error)
    }
  }
}
