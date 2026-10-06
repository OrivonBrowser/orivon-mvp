// Which Orivon surface a tab is showing in each of its three places: a sheet
// over the tab (`center`), a prompt under the address pill (`address`) and a
// cover over the page (`cover`). A feature asks for a slot instead of calling
// `overlays.show`, so two sheets never stack, two prompts never overlap, and a
// question asked while another tab is in front waits for its tab. A cover is
// outside the one-surface-at-a-time rule: it lies under whatever else the tab
// shows. Pure over the window's `overlays` and `tabs`: no `electron` import,
// unit-tested with fake windows.
import type { ShellWindow } from '../shell/window-registry.js'
import type { OverlayAnchor, OverlayCloseReason } from './overlay-types.js'

/** The places a tab queues asks for, one shown at a time: a sheet over the tab, or a prompt under the address pill. */
type QueuedSlot = 'center' | 'address'

/** A sheet over the tab, a prompt under the address pill, or a cover over the page: at most one, which a newer ask replaces. */
export type TabSlot = QueuedSlot | 'cover'

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

/** What sits behind a sheet while it is shown, so a sheet is never drawn over a backdrop of the wrong theme. */
export interface SheetBackdrop {
  raise: (window: ShellWindow, tabId: string) => void
  lower: (window: ShellWindow, tabId: string) => void
}

const NO_BACKDROP: SheetBackdrop = { raise: () => {}, lower: () => {} }

/** Asks waiting behind the one at the head of a tab's slot; one more ends `queue-full`. */
export const MAX_WAITING = 3

interface Entry { readonly ask: SlotAsk, done: boolean }

/** Per tab: each queued slot's asks in arrival order (the head is the one to show), the one on screen, and the cover with whether it is on screen. */
interface TabAsks { center: Entry[], address: Entry[], shown: Entry | null, cover: Entry | null, coverShown: boolean }

export interface TabSlots {
  requestSlot: (ask: SlotAsk) => { cancel: () => void }
  /** The tab has a sheet or a prompt on screen or waiting: closing the tab's page would drop the person's answer. A cover holds no answer and never counts. */
  hasAsk: (window: ShellWindow, tabId: string) => boolean
  slotClosed: (window: ShellWindow, overlay: string, reason: OverlayCloseReason) => void
  /** The tab came to the front: its waiting asks may show (after the window's own tab-switch close has run). */
  tabActivated: (window: ShellWindow, tabId: string) => void
  /** The tab is gone: every ask of it ends `tab-closed`. */
  tabClosed: (window: ShellWindow, tabId: string) => void
  /** What an ask hangs from has moved: each one shown in the window is placed under its anchor as it is now. */
  anchorsMoved: (window: ShellWindow) => void
}

/** `defer` runs a function after the current synchronous turn; tests pass their own. */
export function createTabSlots (defer: (run: () => void) => void = queueMicrotask, backdrop: () => SheetBackdrop = () => NO_BACKDROP): TabSlots {
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

  /** Shows the tab's cover when its tab is in front and it is not on screen. Run before the head ask, which lies over it. */
  function presentCover (window: ShellWindow, tabId: string, tab: TabAsks): void {
    const entry = tab.cover
    if (entry === null || tab.coverShown || !isActive(entry.ask)) return
    tab.coverShown = true
    try {
      window.overlays.show(entry.ask.overlay, entry.ask.anchor?.(), entry.ask.payload)
    } catch (error) {
      console.error(`[tab-slots] showing ${entry.ask.overlay} failed:`, error)
      tab.cover = null
      tab.coverShown = false
      finish(entry, 'request')
    }
  }

  /** Shows the next ask of this tab when its tab is in front and nothing of it is on screen: one surface
   * per tab at a time, sheet before prompt, because two popups would close each other. A cover is not one
   * of them: it is shown first, whatever else is on screen. */
  function present (window: ShellWindow, tabId: string): void {
    const tab = tabsOf(window).get(tabId)
    if (tab === undefined) return
    presentCover(window, tabId, tab)
    if (tab.shown !== null) return
    for (let attempts = 0; attempts < 2 * (MAX_WAITING + 1); attempts++) {
      const next = tab.center[0] ?? tab.address[0]
      if (next === undefined || !isActive(next.ask)) return
      tab.shown = next
      try {
        window.overlays.show(next.ask.overlay, next.ask.anchor?.(), next.ask.payload)
        if (next.ask.slot === 'center') backdrop().raise(window, tabId)
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
    const { slot } = entry.ask
    if (slot === 'cover') {
      if (tab.cover === entry) { tab.cover = null; tab.coverShown = false }
      return
    }
    tab[slot] = tab[slot].filter((other) => other !== entry)
    if (tab.shown === entry) tab.shown = null
  }

  function forget (window: ShellWindow, tabId: string, tab: TabAsks): void {
    if (tab.shown === null && tab.cover === null && tab.center.length === 0 && tab.address.length === 0) tabsOf(window).delete(tabId)
  }

  /** One ask ends: the next shows, unless the popup was pushed out by another (showing ours would close
   * that one the person just opened) or the window is going. A later ask, or the tab's next activation,
   * shows it. */
  function end (window: ShellWindow, tabId: string, entry: Entry, reason: SlotCloseReason): void {
    const tab = tabsOf(window).get(tabId)
    if (tab !== undefined) remove(tab, entry)
    if (entry.ask.slot === 'center') backdrop().lower(window, tabId)
    finish(entry, reason)
    if (tab === undefined) return
    // A cover is no queue's head: its end advances nothing.
    if (entry.ask.slot !== 'cover' && reason !== 'replaced' && reason !== 'window-closed') present(window, tabId)
    forget(window, tabId, tab)
  }

  return {
    requestSlot (ask) {
      const entry: Entry = { ask, done: false }
      const tabs = tabsOf(ask.window)
      const tab = tabs.get(ask.tabId) ?? { center: [], address: [], shown: null, cover: null, coverShown: false }
      if (ask.slot === 'cover') {
        tabs.set(ask.tabId, tab)
        const older = tab.cover
        tab.cover = entry
        // The overlay stays open for the new ask: it is shown again, so its show runs with the new payload.
        tab.coverShown = false
        if (older !== null) finish(older, 'replaced')
        present(ask.window, ask.tabId)
      } else {
        if (tab[ask.slot].length > MAX_WAITING) {
          finish(entry, 'queue-full')
          return { cancel: () => {} }
        }
        tabs.set(ask.tabId, tab)
        tab[ask.slot].push(entry)
        present(ask.window, ask.tabId)
      }
      return {
        cancel: () => {
          if (entry.done) return
          if (tab.shown === entry || (tab.cover === entry && tab.coverShown)) {
            try { ask.window.overlays.close(ask.overlay) } catch (error) { console.error('[tab-slots] closing an overlay failed:', error) }
          }
          if (!entry.done) end(ask.window, ask.tabId, entry, 'request')
        }
      }
    },

    hasAsk (window, tabId) {
      const tab = tabsOf(window).get(tabId)
      return tab !== undefined && (tab.shown !== null || tab.center.length > 0 || tab.address.length > 0)
    },

    slotClosed (window, overlay, reason) {
      for (const [tabId, tab] of tabsOf(window)) {
        const covering = tab.cover
        if (covering !== null && tab.coverShown && covering.ask.overlay === overlay) {
          // Leaving the tab hides its cover and keeps it, as for any ask.
          if (reason === 'tab-switch') tab.coverShown = false
          else end(window, tabId, covering, reason)
          return
        }
        const entry = tab.shown
        if (entry === null || entry.ask.overlay !== overlay) continue
        // Leaving the tab hides its ask and keeps it: it shows again when the tab comes back.
        if (reason === 'tab-switch') {
          tab.shown = null
          if (entry.ask.slot === 'center') backdrop().lower(window, tabId)
        } else end(window, tabId, entry, reason)
        return
      }
    },

    tabActivated (window, tabId) {
      defer(() => { present(window, tabId) })
    },

    anchorsMoved (window) {
      for (const tab of tabsOf(window).values()) {
        const ask = tab.shown?.ask
        const anchor = ask?.anchor?.()
        if (ask === undefined || anchor === undefined) continue
        try { window.overlays.reanchor(ask.overlay, anchor) } catch (error) { console.error('[tab-slots] placing an ask again failed:', error) }
      }
    },

    tabClosed (window, tabId) {
      const tabs = tabsOf(window)
      const tab = tabs.get(tabId)
      if (tab === undefined) return
      tabs.delete(tabId)
      const shown = tab.shown
      const cover = tab.coverShown ? tab.cover : null
      tab.shown = null
      for (const entry of [shown, cover]) {
        if (entry === null) continue
        try { window.overlays.close(entry.ask.overlay) } catch (error) { console.error('[tab-slots] closing an overlay failed:', error) }
      }
      for (const entry of [...tab.center, ...tab.address, ...(tab.cover === null ? [] : [tab.cover])]) finish(entry, 'tab-closed')
      tab.center = []
      tab.address = []
      tab.cover = null
      tab.coverShown = false
    }
  }
}

let sheetBackdrop: SheetBackdrop = NO_BACKDROP

/** The real backdrop, installed once the shell exists; until then sheets raise nothing. */
export function setSheetBackdrop (next: SheetBackdrop): void {
  sheetBackdrop = next
}

const slots = createTabSlots(queueMicrotask, () => sheetBackdrop)

/** Asks to show `overlay` in a slot of a tab; `cancel` withdraws the ask. */
export const requestSlot = slots.requestSlot

/** Whether a tab has an ask shown or queued. */
export const hasAsk = slots.hasAsk

/** A def's `closed` hook forwards here so the slot knows its surface is gone. */
export const slotClosed = slots.slotClosed

/** The chrome reported that the address pill moved. */
export const slotAnchorsMoved = slots.anchorsMoved

/** What the shell's tab events call; a feature never does. */
export const tabSlotEvents: Pick<TabSlots, 'tabActivated' | 'tabClosed'> = slots
