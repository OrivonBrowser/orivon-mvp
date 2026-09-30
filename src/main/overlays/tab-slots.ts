// Which Orivon surface a tab is showing in each of its two places: a sheet
// over the tab (`center`) and a prompt under the address pill (`address`). A
// feature asks for a slot instead of calling `overlays.show`, so two sheets
// never stack, two prompts never overlap, and a question asked while another
// tab is in front waits for its tab. Pure over the window's `overlays` and
// `tabs`: no `electron` import, unit-tested with fake windows.
import type { ShellWindow } from '../shell/window-registry.js'
import type { OverlayAnchor, OverlayCloseReason } from './overlay-types.js'

/** A sheet over the tab, or a prompt under the address pill. */
export type TabSlot = 'center' | 'address'

export type SlotCloseReason = OverlayCloseReason | 'tab-closed' | 'queue-full'

export interface SlotAsk {
  readonly window: ShellWindow
  readonly tabId: string
  readonly slot: TabSlot
  /** The overlay to show; it must be in OVERLAYS and forward its `closed` to `slotClosed`. */
  readonly overlay: string
  readonly payload: unknown
  /** Read each time the ask is shown, so a prompt that waited opens under where the pill is now. */
  readonly anchor?: () => OverlayAnchor | undefined
  /** Called exactly once: with why the ask ended, answered or not. */
  readonly closed: (reason: SlotCloseReason) => void
}

/** Asks waiting behind the one at the head of a tab's slot; one more ends `queue-full`. */
export const MAX_WAITING = 3

interface Entry { readonly ask: SlotAsk, done: boolean }

/** Per tab: each slot's asks in arrival order (the head is the one to show), and the one on screen. */
interface TabAsks { center: Entry[], address: Entry[], shown: Entry | null }

export interface TabSlots {
  requestSlot: (ask: SlotAsk) => { cancel: () => void }
  slotClosed: (window: ShellWindow, overlay: string, reason: OverlayCloseReason) => void
  /** The tab came to the front: its waiting asks may show (after the window's own tab-switch close has run). */
  tabActivated: (window: ShellWindow, tabId: string) => void
  /** The tab is gone: every ask of it ends `tab-closed`. */
  tabClosed: (window: ShellWindow, tabId: string) => void
}

/** `defer` runs a function after the current synchronous turn; tests pass their own. */
export function createTabSlots (defer: (run: () => void) => void = queueMicrotask): TabSlots {
  const windows = new WeakMap<ShellWindow, Map<string, TabAsks>>()

  const tabsOf = (window: ShellWindow): Map<string, TabAsks> => {
    let tabs = windows.get(window)
    if (tabs === undefined) windows.set(window, tabs = new Map())
    return tabs
  }

  function finish (entry: Entry, reason: SlotCloseReason): void {
    if (entry.done) return
    entry.done = true
    try {
      entry.ask.closed(reason)
    } catch (error) {
      console.error('[tab-slots] an ask\'s closed hook failed:', error)
    }
  }

  function isActive (ask: SlotAsk): boolean {
    return ask.window.tabs.getState().activeTabId === ask.tabId
  }

  /** Shows the next ask of this tab when its tab is in front and nothing of it is on screen: one surface
   * per tab at a time, sheet before prompt, because two popups would close each other. */
  function present (window: ShellWindow, tabId: string): void {
    const tab = tabsOf(window).get(tabId)
    if (tab === undefined || tab.shown !== null) return
    for (let attempts = 0; attempts < 2 * (MAX_WAITING + 1); attempts++) {
      const next = tab.center[0] ?? tab.address[0]
      if (next === undefined || !isActive(next.ask)) return
      tab.shown = next
      try {
        window.overlays.show(next.ask.overlay, next.ask.anchor?.(), next.ask.payload)
        return
      } catch (error) {
        console.error(`[tab-slots] showing ${next.ask.overlay} failed:`, error)
        tab.shown = null
        remove(tab, next)
        finish(next, 'request')
      }
    }
  }

  function remove (tab: TabAsks, entry: Entry): void {
    tab[entry.ask.slot] = tab[entry.ask.slot].filter((other) => other !== entry)
    if (tab.shown === entry) tab.shown = null
  }

  function forget (window: ShellWindow, tabId: string, tab: TabAsks): void {
    if (tab.shown === null && tab.center.length === 0 && tab.address.length === 0) tabsOf(window).delete(tabId)
  }

  /** One ask ends: the next shows, unless the popup was pushed out by another (showing ours would close
   * that one the person just opened) or the window is going. A later ask, or the tab's next activation,
   * shows it. */
  function end (window: ShellWindow, tabId: string, entry: Entry, reason: SlotCloseReason): void {
    const tab = tabsOf(window).get(tabId)
    if (tab !== undefined) remove(tab, entry)
    finish(entry, reason)
    if (tab === undefined) return
    if (reason !== 'replaced' && reason !== 'window-closed') present(window, tabId)
    forget(window, tabId, tab)
  }

  return {
    requestSlot (ask) {
      const entry: Entry = { ask, done: false }
      const tabs = tabsOf(ask.window)
      const tab = tabs.get(ask.tabId) ?? { center: [], address: [], shown: null }
      if (tab[ask.slot].length > MAX_WAITING) {
        finish(entry, 'queue-full')
        return { cancel: () => {} }
      }
      tabs.set(ask.tabId, tab)
      tab[ask.slot].push(entry)
      present(ask.window, ask.tabId)
      return {
        cancel: () => {
          if (entry.done) return
          if (tab.shown === entry) {
            try { ask.window.overlays.close(ask.overlay) } catch (error) { console.error('[tab-slots] closing an overlay failed:', error) }
          }
          if (!entry.done) end(ask.window, ask.tabId, entry, 'request')
        }
      }
    },

    slotClosed (window, overlay, reason) {
      for (const [tabId, tab] of tabsOf(window)) {
        const entry = tab.shown
        if (entry === null || entry.ask.overlay !== overlay) continue
        // Leaving the tab hides its ask and keeps it: it shows again when the tab comes back.
        if (reason === 'tab-switch') tab.shown = null
        else end(window, tabId, entry, reason)
        return
      }
    },

    tabActivated (window, tabId) {
      defer(() => { present(window, tabId) })
    },

    tabClosed (window, tabId) {
      const tabs = tabsOf(window)
      const tab = tabs.get(tabId)
      if (tab === undefined) return
      tabs.delete(tabId)
      const shown = tab.shown
      tab.shown = null
      if (shown !== null) {
        try { window.overlays.close(shown.ask.overlay) } catch (error) { console.error('[tab-slots] closing an overlay failed:', error) }
      }
      for (const entry of [...tab.center, ...tab.address]) finish(entry, 'tab-closed')
      tab.center = []
      tab.address = []
    }
  }
}

const slots = createTabSlots()

/** Asks to show `overlay` in a slot of a tab; `cancel` withdraws the ask. */
export const requestSlot = slots.requestSlot

/** A def's `closed` hook forwards here so the slot knows its surface is gone. */
export const slotClosed = slots.slotClosed

/** What the shell's tab events call; a feature never does. */
export const tabSlotEvents: Pick<TabSlots, 'tabActivated' | 'tabClosed'> = slots
