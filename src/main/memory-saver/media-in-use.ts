// Which pages use the camera, the microphone, a screen share or a chosen device right now. Whatever grants one must
// mark the page here; a page that navigates is no longer in use, so a mark ends with its document. A page sharing a
// screen is marked while its share runs (`../display-capture/`). A camera or microphone grant marks nothing:
// Electron reports no running stream to main, so a granted page can still sleep (provisional; ADR-0032).
import type { WebContents } from 'electron'

const inUse = new WeakSet<WebContents>()

/** The page behind `contents` started using a device. */
export function markMediaInUse (contents: WebContents): void {
  inUse.add(contents)
}

/** The page stopped, or went to another document. */
export function clearMediaInUse (contents: WebContents): void {
  inUse.delete(contents)
}

export function mediaInUse (contents: WebContents): boolean {
  return inUse.has(contents)
}
