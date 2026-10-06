// A short-lived record, per extension, that the person just did something to it in the browser: clicked its
// toolbar button, pressed one of its keys, chose one of its context-menu items, or clicked or typed in one of its
// pages. `chrome.sidePanel.open` needs one, and spends it. Only browser-side input feeds this: a page's own
// `dispatchEvent` or user-activation claim never reaches it. No Electron runtime import.
import type { WebContents } from 'electron'
import { recordTabCaptureInvocation } from './extension-tab-capture-invocation.js'

/** How long input counts as "just now" (provisional: Chrome's own window is not measured here). */
export const GESTURE_WINDOW_MS = 5000

export interface GestureLedger {
  /** The person has just acted on `extensionId`. */
  readonly record: (extensionId: string) => void
  /** There is input newer than the window that no `open` has spent. */
  readonly available: (extensionId: string) => boolean
  /** Uses the input up: the next `open` needs a new one. */
  readonly spend: (extensionId: string) => void
  readonly clear: (extensionId: string) => void
}

export function createGestureLedger (clock: () => number = Date.now, windowMs: number = GESTURE_WINDOW_MS): GestureLedger {
  const last = new Map<string, number>()
  return {
    record: (id) => { last.set(id, clock()) },
    available: (id) => {
      const at = last.get(id)
      return at !== undefined && clock() - at <= windowMs
    },
    spend: (id) => { last.delete(id) },
    clear: (id) => { last.delete(id) }
  }
}

/** The ledger of the running browser: toolbar clicks, command keys, context-menu clicks and input on an extension's
 * own pages feed it, and `chrome.sidePanel.open` reads it. */
export const sidePanelGestures: GestureLedger = createGestureLedger()

/** A toolbar click or a command key on `tab`: it counts as a tabCapture invocation and as the gesture `sidePanel.open` needs. */
export function recordExtensionInvocation (extensionId: string, tab: WebContents): void {
  recordTabCaptureInvocation(extensionId, tab)
  sidePanelGestures.record(extensionId)
}
