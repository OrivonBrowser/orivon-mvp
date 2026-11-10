// Whether a service worker controls a page's main-frame document. Only the renderer knows: the browser process answers a
// navigation a worker handles without a request the session's web-request hooks see, and Electron names no controller for a
// WebContents. The tab's preload reads `navigator.serviceWorker.controller` in its own isolated world, where the page's
// scripts cannot reach or change it, and tells main as the document begins (`../../preload/worker-control.ts`). Tied to
// Electron through the IPC channel and the `WebContents` that sent it.
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { WORKER_CONTROL_CHANNEL } from '../channels.js'

/** The address, without a fragment, of the document each page reported a worker controls. One per page: the next navigation forgets it. */
const controlled = new WeakMap<object, string>()

function documentUrl (url: string): string | undefined {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

/** A worker controls the document of `page` at `url`. */
export function noteWorkerControl (page: object, url: string): void {
  const at = documentUrl(url)
  if (at === undefined) controlled.delete(page)
  else controlled.set(page, at)
}

/** A navigation of `page` starts: a report made by the document before it says nothing of the next. */
export function forgetWorkerControl (page: object): void {
  controlled.delete(page)
}

/** Whether the preload reported that a worker controls the document of `page` that committed at `url`. */
export function isControlledByWorker (page: object, url: string): boolean {
  const reported = controlled.get(page)
  return reported !== undefined && reported === documentUrl(url)
}

/**
 * Keeps what a tab's top frame reported. A frame that is not the top frame has no preload that sends this, so a message from
 * one is dropped, and so is a payload that is not exactly an address: the renderer is not trusted to send the shape.
 */
export function takeWorkerControlReport (sender: WebContents, senderFrame: unknown, payload: unknown): void {
  if (senderFrame === null || senderFrame === undefined || senderFrame !== sender.mainFrame) return
  if (typeof payload !== 'object' || payload === null) return
  const { documentUrl: url } = payload as { documentUrl?: unknown }
  if (typeof url === 'string') noteWorkerControl(sender, url)
}

export function installWorkerControlReports (): void {
  ipcMain.on(WORKER_CONTROL_CHANNEL, (event, payload: unknown) => { takeWorkerControlReport(event.sender, event.senderFrame, payload) })
}
