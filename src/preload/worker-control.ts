// Tells main, as a document begins, that a service worker controls it. A navigation a worker answers reaches no web-request
// hook, and Electron names no controller for a page, so only the document's own renderer can say. This runs in the preload's
// isolated world: the page's scripts have no handle on `ipcRenderer` and cannot change what the platform reports here, so the
// report is the browser's own record of the controller. Main matches it against the address the document committed at and the
// workers it let be installed (src/main/sessions/worker-control.ts). Nothing is exposed to the page.
import { ipcRenderer } from 'electron'
import { WORKER_CONTROL_CHANNEL } from '../main/channels.js'
import { inMainFrame } from './frame.js'

/** Sends the report when a worker controls this document; a document nothing controls sends nothing. Top frame only. */
export function installWorkerControlReport (): void {
  if (!inMainFrame()) return
  let controller: unknown
  try {
    // Absent in a context that cannot have workers (an insecure origin, an opaque one).
    controller = navigator.serviceWorker?.controller
  } catch {
    return
  }
  if (controller === null || controller === undefined) return
  ipcRenderer.send(WORKER_CONTROL_CHANNEL, { documentUrl: location.href })
}
