// A short-lived record, per extension, that the person just did something to it in the browser: clicked its
// toolbar button, pressed one of its keys, chose one of its context-menu items, or clicked or typed in one of its
// pages. `chrome.sidePanel.open` needs one, and spends it. A second kind comes from the page itself: the person's
// click or key in a tab the extension reaches (`createTabGesture`), which lets a content script's message stand for
// the click. Only browser-side input feeds either: a page's own `dispatchEvent` or user-activation claim never
// reaches it. No Electron runtime import.
import type { WebContents } from 'electron'
import { TabInteraction } from '../site-settings/tab-interaction.js'
import type { InputTab } from '../site-settings/tab-interaction.js'
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

export interface TabGesture<T extends InputTab & object> {
  /** Starts hearing the browser's input in `tab`. */
  readonly watch: (tab: T) => void
  /**
   * The person clicked or pressed a key in `tab` within the window, `reachesPage` (the extension runs code in `tab`'s page),
   * and no other extension has spent that input. The extension that spent it may use it again: a page that sends two
   * requests from one click gets one answer for both.
   */
  readonly available: (tab: T, reachesPage: boolean, extensionId: string) => boolean
  /** `extensionId` opened a panel for this input: no other extension can use it. */
  readonly spend: (tab: T, extensionId: string) => void
}

/**
 * The gesture a click on a page gives an extension that runs a content script there. Chrome carries the content script's
 * user activation into the worker; Orivon carries the browser's own record of the input instead. The record is per tab,
 * and an input is spent by the first extension that uses it, so one click opens panels for one extension however many
 * reach the page.
 */
export function createTabGesture<T extends InputTab & object> (clock: () => number = Date.now, windowMs: number = GESTURE_WINDOW_MS): TabGesture<T> {
  const input = new TabInteraction<T>(clock)
  /** Who spent the tab's input; meaningful only while the input is marked spent, which new input and a navigation undo. */
  const spentBy = new WeakMap<T, string>()
  return {
    watch: (tab) => { input.watch(tab) },
    available: (tab, reachesPage, extensionId) => {
      if (!reachesPage) return false
      const { at, consumed } = input.read(tab)
      if (at === null || clock() - at > windowMs) return false
      return !consumed || spentBy.get(tab) === extensionId
    },
    spend: (tab, extensionId) => {
      input.consume(tab)
      spentBy.set(tab, extensionId)
    }
  }
}

/** The tabs of the running browser: `side-panel-runner.ts` watches every web contents it creates. */
export const sidePanelTabGestures: TabGesture<WebContents> = createTabGesture()

/** The ledger of the running browser: toolbar clicks, command keys, context-menu clicks and input on an extension's
 * own pages feed it, and `chrome.sidePanel.open` reads it. */
export const sidePanelGestures: GestureLedger = createGestureLedger()

/** A toolbar click or a command key on `tab`: it counts as a tabCapture invocation and as the gesture `sidePanel.open` needs. */
export function recordExtensionInvocation (extensionId: string, tab: WebContents): void {
  recordTabCaptureInvocation(extensionId, tab)
  sidePanelGestures.record(extensionId)
}
