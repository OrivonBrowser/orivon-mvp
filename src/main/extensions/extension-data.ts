// What an extension leaves behind besides its own folder: its web storage (localStorage, IndexedDB,
// caches, service worker) and the stores behind chrome.storage. Removing the extension empties both,
// as Chrome does, so installing it again starts clean.
import type { InstallContext } from './install-runner.js'

const EXTENSION_ID = /^[a-p]{32}$/

/** Run while the extension is still loaded: chrome.storage can only be emptied through its own origin. */
export async function deleteExtensionData (ctx: InstallContext, id: string): Promise<void> {
  if (!EXTENSION_ID.test(id)) return
  try {
    await ctx.clearExtensionStorage?.(id)
  } catch {
    // No chrome.storage to empty: the extension holds no `storage` permission, or its page would not open.
  }
  try {
    await ctx.session.clearStorageData({ origin: `chrome-extension://${id}` })
  } catch (error) {
    console.error(`[extensions] could not clear the web storage of ${id}:`, error)
  }
}
