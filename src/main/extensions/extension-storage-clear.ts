// Empties an extension's chrome.storage from inside its own origin. The stores behind it stay open in
// Chromium for as long as the process runs, so deleting their files while the extension loaded would
// leave a later install in the same run reading the old values and writing into unlinked files; only
// the extension's own API can empty them in place. Needs the extension loaded.
import { BrowserWindow } from 'electron'
import type { Session } from 'electron'

const CLEAR_SCRIPT = "Promise.all(['local', 'sync'].map((area) => chrome.storage[area].clear()))"

/** Rejects when the extension has no chrome.storage (it holds no `storage` permission, so it keeps nothing there). */
export async function clearChromeStorage (session: Session, id: string): Promise<void> {
  const window = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true } })
  try {
    await window.loadURL(`chrome-extension://${id}/manifest.json`)
    await window.webContents.executeJavaScript(CLEAR_SCRIPT, true)
  } finally {
    window.destroy()
  }
}
