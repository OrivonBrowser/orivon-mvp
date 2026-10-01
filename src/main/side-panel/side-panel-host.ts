// One panel per window: whether it is open, which view it shows, how wide it is and which side it sits on, plus
// the slot for a view Orivon does not draw (an extension's page). The panel's own page is the `side-panel`
// overlay (./side-panel-overlay.ts); this is what the rest of the shell and other code talk to.
import type { BaseWindow, WebContents, WebContentsView } from 'electron'
import { dockBounds } from '../overlays/overlay-bounds.js'
import type { OverlayHostHandle } from '../overlays/overlay-host.js'
import { contain } from '../shell/contain.js'
import type { PageInsets } from '../shell/window-layout.js'
import type { Bounds } from '../shell/tab-types.js'
import type { WindowContext } from '../shell/window-context.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { viewById } from './panel-views.js'
import { announceChosen, guestEntries, isGuestEntry, watchGuestEntries } from './side-panel-guests.js'
import { clampWidth, EDGE_WIDTH, fits, HEADER_HEIGHT, insetsFor, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from './side-panel-model.js'
import type { PanelSide } from './side-panel-model.js'
import { storeFor } from './side-panel-stores.js'

export { guestEntries, onGuestChosen, setGuestEntries } from './side-panel-guests.js'
export type { PanelGuestEntry } from './side-panel-guests.js'

export const SIDE_PANEL_OVERLAY = 'side-panel'

export interface PanelGuest {
  id: string
  title: string
  icon?: string
  view: WebContentsView
  /** Runs once when the view leaves the panel: the panel closes, another view is chosen, or `setGuest(null)`. */
  closed?: () => void
}

export interface SidePanelHost {
  isOpen: () => boolean
  open: (viewId?: string) => void
  close: () => void
  toggle: (viewId?: string) => void
  view: () => string
  width: () => number
  side: () => PanelSide
  /** The panel below its header, in window-content pixels; null while it is closed or hidden. */
  bodyBounds: () => Bounds | null
  /** Shows a view Orivon does not draw over the body, header kept. */
  setGuest: (guest: PanelGuest | null) => void
  onChange: (listener: () => void) => () => void
}

/** What a window's own code lends the panel: the overlay host's stacking and the page area as laid out now. */
export interface PanelWiring {
  adopt: OverlayHostHandle['adopt']
  area: () => Bounds
}

const hosts = new WeakMap<BaseWindow, PanelHost>()
const wirings = new WeakMap<BaseWindow, PanelWiring>()
const everyHost = new Set<PanelHost>()
/** Listeners are kept by window, not by panel: the shell starts listening before the window's hook has made the panel. */
const changeListeners = new WeakMap<BaseWindow, Set<() => void>>()

/** Every window that has a panel hears when the picker's entries change. */
watchGuestEntries(() => { for (const host of everyHost) host.entriesChanged() })

const NOBODY: SidePanelHost = {
  isOpen: () => false, open: () => {}, close: () => {}, toggle: () => {}, view: () => 'bookmarks', width: () => 0, side: () => 'right',
  bodyBounds: () => null, setGuest: (guest) => { try { guest?.closed?.() } catch { /* nothing holds it */ } }, onChange: () => () => {}
}

/** The window's panel; an inert one for a window that has none (it is being built or closed). */
export function sidePanelFor (window: ShellWindow): SidePanelHost {
  return hosts.get(window.window) ?? NOBODY
}

/** Calls `listener` whenever this window's panel opens, closes, changes view, width or side; returns the stop. */
export function onPanelChange (window: ShellWindow, listener: () => void): () => void {
  let set = changeListeners.get(window.window)
  if (set === undefined) { set = new Set(); changeListeners.set(window.window, set) }
  set.add(listener)
  return () => { set.delete(listener) }
}

/** The window's own panel object, for the overlay's handler: it needs more than the public surface. */
export function panelOf (window: ShellWindow): PanelHost | undefined {
  return hosts.get(window.window)
}

/** What an open panel takes from each side of this window's page area, for the layout. */
export function sidePanelInsets (win: BaseWindow): PageInsets {
  return hosts.get(win)?.insets() ?? { left: 0, right: 0 }
}

/** Called once by the window, before its first layout: lends the panel what it cannot reach from a `WindowContext`. */
export function wireSidePanel (win: BaseWindow, wiring: PanelWiring): void {
  wirings.set(win, wiring)
  // A guest is not a popup: it is never closed by one, only lifted above the panel and under the popups.
  wiring.adopt({ close: () => {} }, () => { hosts.get(win)?.restackGuest() })
}

/** The panel of a window that is opening. Returns it so the caller can stop it when the window closes. */
export function createSidePanel (ctx: WindowContext): PanelHost {
  const host = new PanelHost(ctx, wirings.get(ctx.window.window))
  hosts.set(ctx.window.window, host)
  everyHost.add(host)
  return host
}

export class PanelHost implements SidePanelHost {
  private wanted = false
  private current = ''
  private shownWidth = 0
  private guest: PanelGuest | null = null
  private pendingWidth: number | null = null
  private stopped = false

  constructor (private readonly ctx: WindowContext, private readonly wiring: PanelWiring | undefined) {
    this.current = this.storedView()
    this.shownWidth = this.store().get().width
  }

  private get window (): ShellWindow { return this.ctx.window }
  private store (): ReturnType<typeof storeFor> { return storeFor(this.ctx.services) }
  private contentWidth (): number { return this.window.window.isDestroyed() ? 0 : this.window.window.getContentBounds().width }
  private storedView (): string {
    const stored = this.store().get().view
    return viewById(stored) === undefined ? 'bookmarks' : stored
  }

  /** Whether this window can show a panel at all: a kiosk never does, and a narrow window has no room. */
  private room (): boolean {
    return !this.ctx.services.kiosk && fits(this.contentWidth())
  }

  /** On screen right now: wanted, with room, and no page holding the whole window. */
  private visible (): boolean {
    return this.wanted && this.room() && !this.window.shortcutsSuspended()
  }

  isOpen = (): boolean => this.wanted && this.room()
  view = (): string => this.current
  width = (): number => clampWidth(this.shownWidth, this.contentWidth())
  side = (): PanelSide => this.ctx.services.settings.get('sidePanel.side') === 'left' ? 'left' : 'right'

  insets (): PageInsets {
    return insetsFor({
      open: this.wanted, side: this.side(), width: this.shownWidth, windowWidth: this.contentWidth(),
      fullscreen: this.window.shortcutsSuspended(), kiosk: this.ctx.services.kiosk
    })
  }

  bodyBounds (): Bounds | null {
    if (!this.visible() || this.wiring === undefined) return null
    const { width, height } = this.window.window.getContentBounds()
    const dock = dockBounds({ width, height, area: this.wiring.area() })
    // Clear of the resize edge on the page side, so the edge can still be grabbed under a guest.
    const left = this.side() === 'left' ? 0 : EDGE_WIDTH
    return { x: dock.x + left, y: dock.y + HEADER_HEIGHT, width: Math.max(0, dock.width - EDGE_WIDTH), height: Math.max(0, dock.height - HEADER_HEIGHT) }
  }

  /** What the resize edge reports: the range this window allows, and the width a double click returns to. */
  limits (): { min: number, max: number, reset: number } {
    const max = clampWidth(PANEL_MAX, this.contentWidth())
    return { min: PANEL_MIN, max, reset: Math.min(PANEL_DEFAULT, max) }
  }

  /** Whether `id` is something the panel can show: one of Orivon's views or a listed entry. */
  accepts (id: string): boolean {
    return viewById(id) !== undefined || isGuestEntry(id)
  }

  open (viewId?: string): void {
    if (this.stopped || !this.room()) return
    if (viewId !== undefined && !this.accepts(viewId)) return
    const was = this.wanted
    if (!was) this.shownWidth = this.store().get().width
    this.wanted = true
    // Before the page and the overlay are laid out: both read the page area this changes.
    if (viewId !== undefined) this.choose(viewId)
    this.window.relayout()
    if (!this.window.overlays.isOpen(SIDE_PANEL_OVERLAY)) this.window.overlays.show(SIDE_PANEL_OVERLAY)
    this.syncGuest()
    this.notify()
  }

  close (): void {
    if (!this.wanted) return
    this.wanted = false
    this.release()
    this.fallBack()
    this.window.overlays.close(SIDE_PANEL_OVERLAY)
    this.window.relayout()
    this.focusPage()
    this.notify()
  }

  toggle (viewId?: string): void {
    if (this.isOpen() && (viewId === undefined || viewId === this.current)) this.close()
    else this.open(viewId)
  }

  /** The panel's page chose a view, or `open` named one. */
  choose (id: string): void {
    if (!this.accepts(id) || id === this.current) return
    if (this.guest !== null && this.guest.id !== id) this.release()
    this.current = id
    if (viewById(id) !== undefined) this.store().set({ view: id })
    this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'view', view: id, guest: this.guestSummary() })
    if (isGuestEntry(id)) announceChosen(this.window, id)
    this.notify()
  }

  /** The person dragged the edge or pressed a key on it. Applied at most once per turn of the event loop. */
  resize (width: number): void {
    if (!Number.isFinite(width)) return
    const first = this.pendingWidth === null
    this.pendingWidth = width
    if (!first) return
    setImmediate(() => {
      const next = this.pendingWidth
      this.pendingWidth = null
      if (next === null || this.stopped || !this.wanted) return
      this.shownWidth = clampWidth(next, this.contentWidth())
      this.store().set({ width: this.shownWidth })
      this.window.relayout()
      this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'width', width: this.width(), limits: this.limits() })
      this.notify()
    })
  }

  setGuest (guest: PanelGuest | null): void {
    if (this.stopped) { guest?.closed?.(); return }
    if (guest === null) {
      this.release()
      this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'view', view: this.current, guest: null })
      this.notify()
      return
    }
    if (this.guest !== null && this.guest.view !== guest.view) this.release()
    this.guest = guest
    this.current = guest.id
    this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'view', view: guest.id, guest: this.guestSummary() })
    this.syncGuest()
    this.notify()
  }

  /** The guest, as the page draws its header. */
  guestSummary (): { id: string, title: string, icon?: string } | null {
    return this.guest === null ? null : { id: this.guest.id, title: this.guest.title, ...(this.guest.icon === undefined ? {} : { icon: this.guest.icon }) }
  }

  /** The overlay closed without `close()` asking: its renderer died, or the window is going. */
  overlayClosed (reason: string): void {
    if (reason === 'window-closed') { this.release(); return }
    if (!this.wanted) return
    this.wanted = false
    this.release()
    this.fallBack()
    this.window.relayout()
    this.notify()
  }

  /** The overlay was repositioned (resize, bar toggled, fullscreen): the guest follows it. */
  moved (): void {
    this.syncGuest()
    this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'width', width: this.width(), limits: this.limits() })
  }

  /** The side setting changed. */
  sideChanged (): void {
    if (!this.wanted) return
    this.window.relayout()
    this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'side', side: this.side() })
    this.notify()
  }

  entriesChanged (): void {
    this.window.overlays.send(SIDE_PANEL_OVERLAY, { type: 'guests', guests: guestEntries() })
  }

  focusPage (): void {
    const contents = this.window.tabs.activeWebContents()
    if (contents !== undefined && !contents.isDestroyed()) contents.focus()
  }

  /** On screen now: open, with room, and not hidden by a fullscreen page. The pane order skips a panel that is not. */
  onScreen (): boolean { return this.visible() }

  /** The panel's own page, found among the window's views by its address. */
  private ownPage (): WebContents | undefined {
    for (const child of this.window.window.contentView.children) {
      const contents = (child as Partial<WebContentsView>).webContents
      if (contents !== undefined && !contents.isDestroyed() && contents.getURL().includes(`overlay=${SIDE_PANEL_OVERLAY}`)) return contents
    }
    return undefined
  }

  /** Keyboard focus is inside the panel: its page, or the view standing in for a guest. */
  holdsFocus (): boolean {
    const guest = this.guest?.view.webContents
    return (guest !== undefined && !guest.isDestroyed() && guest.isFocused()) || this.ownPage()?.isFocused() === true
  }

  /** Hands the keyboard to the guest's view when one is shown, else to the panel's page. */
  focusIn (): void {
    const guest = this.guest?.view.webContents
    const target = guest !== undefined && !guest.isDestroyed() ? guest : this.ownPage()
    target?.focus()
  }

  /** Called by the overlay host on every restack: the guest sits directly above the panel and under the popups. */
  restackGuest (): void {
    if (this.guest !== null && this.visible()) this.attachGuest(this.guest)
  }

  onChange (listener: () => void): () => void {
    return onPanelChange(this.window, listener)
  }

  stop (): void {
    this.stopped = true
    this.release()
    changeListeners.delete(this.window.window)
    everyHost.delete(this)
  }

  /** A panel that closes while it waits for an entry's view reopens on one of Orivon's own. */
  private fallBack (): void {
    if (viewById(this.current) === undefined) this.current = this.storedView()
  }

  private notify (): void {
    for (const listener of [...(changeListeners.get(this.window.window) ?? [])]) contain('side panel listener', undefined, listener)
  }

  private attachGuest (guest: PanelGuest): void {
    const bounds = this.bodyBounds()
    const { window } = this.window
    if (bounds === null || window.isDestroyed() || guest.view.webContents.isDestroyed()) return
    guest.view.setBounds(bounds)
    window.contentView.addChildView(guest.view)
  }

  private detachGuest (guest: PanelGuest): void {
    const { window } = this.window
    if (window.isDestroyed() || !window.contentView.children.includes(guest.view)) return
    window.contentView.removeChildView(guest.view)
  }

  /** Shows the guest while the panel shows, hides it while the panel does not. */
  private syncGuest (): void {
    if (this.guest === null) return
    if (this.visible()) this.attachGuest(this.guest)
    else this.detachGuest(this.guest)
  }

  /** The guest leaves the panel: out of the window, and its owner told once. */
  private release (): void {
    const { guest } = this
    if (guest === null) return
    this.guest = null
    // The view that was showing it falls back to the last of Orivon's own, so choosing the entry again announces it again.
    if (this.current === guest.id) this.current = this.storedView()
    this.detachGuest(guest)
    contain('side panel guest closed', undefined, () => { guest.closed?.() })
  }
}
