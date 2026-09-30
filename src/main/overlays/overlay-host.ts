// The per-window overlay host: when each declared overlay exists, where it
// sits, when it closes and where focus goes after. It knows no feature; a
// feature is an OverlayDef (./overlay-types.ts). Views are built lazily, so a
// window carries no overlay renderer until something first shows or warms one.
import type { BaseWindow, View, WebContents, WebContentsView } from 'electron'
import { OVERLAY_EVENT_CHANNEL } from '../channels.js'
import type { Bounds } from '../shell/tab-types.js'
import { onThemeUpdated } from '../shell/theme-colors.js'
import { recordPopoverShown } from '../shell/view-background-test-hook.js'
import type { WindowContext } from '../shell/window-context.js'
import { isAnchor, overlayBounds } from './overlay-bounds.js'
import { createOverlayView, focusedContents } from './overlay-view.js'
import type { FocusTarget, OverlayViewHandle } from './overlay-view.js'
import type { OverlayAnchor, OverlayCloseReason, OverlayDef, OverlayHandler, OverlayHost, OverlayReady } from './overlay-types.js'

const DEFAULT_HEIGHT = { initial: 180, min: 120, max: 460 }

/** Blur closes an overlay on the same mousedown a re-click on its own toolbar button uses to ask for it again, and that click's message reaches main only afterwards; a toggle this soon after our own blur-close is that echo, not fresh intent. */
const REOPEN_DEBOUNCE_MS = 300

/** Events sent before the page has said `ready` are held, up to this many, and delivered once it has. */
const QUEUE_LIMIT = 32

export interface OverlayHostDeps {
  win: BaseWindow
  contentView: View
  /** The caller's own `import.meta.dirname`. */
  dirname: string
  defs: readonly OverlayDef[]
  context: () => WindowContext
  /** The tab area, as the window lays it out now. */
  area: () => Bounds
  activeContents: () => WebContents | undefined
}

export type OverlayHostHandle = OverlayHost & {
  /** Puts a legacy panel under the same close-all and relayout rules. `close` must be idempotent. `restack`, when given, lifts the panel's own view: the host calls it after the bars and before the popups, so a bar re-added on a state push never covers an open panel. */
  adopt: (panel: { close: () => void }, restack?: () => void) => void
  /** Closes the popup overlays but not the adopted panels: for a panel that toggles itself after. */
  closeOverlays: () => void
  tabSwitched: () => void
  navigated: () => void
  relayout: () => void
  restack: () => void
  dispose: () => void
}

interface Slot {
  readonly def: OverlayDef
  handler: OverlayHandler | null
  view: OverlayViewHandle | null
  pageReady: boolean
  /** The page has asked for its first show and has not been answered: events wait for that answer, which carries them. */
  awaitingReply: boolean
  /** The show result the page has not fetched yet. */
  pending: Promise<OverlayReady> | null
  queued: unknown[]
  open: boolean
  anchor: OverlayAnchor | undefined
  height: number
  returnTo: FocusTarget | undefined
  lastBlurCloseAt: number
  /** A `never` overlay whose handler asked for the keyboard: it behaves as `take` until it closes. */
  focusTaken: boolean
}

async function showResult (handler: OverlayHandler, payload: unknown): Promise<OverlayReady> {
  try {
    return { shown: true, payload: await handler.show?.(payload) }
  } catch (error) {
    console.error('[overlay] show failed', error)
    return { shown: true, payload: undefined }
  }
}

export function createOverlayHost (deps: OverlayHostDeps): OverlayHostHandle {
  const slots = new Map<string, Slot>()
  for (const def of deps.defs) {
    if (slots.has(def.name)) throw new Error(`overlay "${def.name}" is declared twice`)
    slots.set(def.name, {
      def, handler: null, view: null, pageReady: false, awaitingReply: false, pending: null, queued: [], open: false,
      anchor: undefined, height: def.height?.initial ?? DEFAULT_HEIGHT.initial, returnTo: undefined, lastBlurCloseAt: 0, focusTaken: false
    })
  }
  const adopted: Array<{ close: () => void, restack?: (() => void) | undefined }> = []
  /** Open slots, oldest first: the order they were shown in. */
  let openOrder: Slot[] = []
  let disposed = false

  const openSlots = (): Slot[] => [...openOrder]

  function boundsFor (slot: Slot): Electron.Rectangle {
    const { width, height } = deps.win.getContentBounds()
    const limits = { min: slot.def.height?.min ?? DEFAULT_HEIGHT.min, max: slot.def.height?.max ?? DEFAULT_HEIGHT.max }
    return overlayBounds(slot.def.placement, slot.anchor, { width, height, area: deps.area() }, slot.height, limits)
  }

  function handlerFor (slot: Slot): OverlayHandler {
    slot.handler ??= slot.def.attach({
      ...deps.context(),
      send: (event) => { send(slot.def.name, event) },
      close: () => { closeSlot(slot, 'request') },
      takeFocus: () => {
        const view = slot.view
        if (!slot.open || view === null || slot.def.focus === 'take' || slot.focusTaken || inBackground()) return
        slot.focusTaken = true
        view.focusWhenReady(() => slot.open && slot.view === view)
      }
    })
    return slot.handler
  }

  /** What this window may hand focus back to: its own chrome, or the tab in front now. A view of another window, or a tab since switched away from, is not. */
  function ownTarget (target: FocusTarget | undefined): FocusTarget | undefined {
    if (target === undefined || target.isDestroyed()) return undefined
    const chrome = deps.context().window.chrome as Partial<WebContentsView> | undefined
    if (chrome?.webContents?.id === target.id) return target
    return deps.activeContents()?.id === target.id ? target : undefined
  }

  /** True when the person is in another window of this app: an overlay shown here must not pull focus there. */
  function inBackground (): boolean {
    if (deps.win.isFocused()) return false
    return deps.context().services.windows.all().some((other) => other.window !== deps.win && !other.window.isDestroyed() && other.window.isFocused())
  }

  /** Where focus goes back to: what held it before this overlay took it, if this window still owns it, else the active tab. */
  function restoreFocus (slot: Slot, reason: OverlayCloseReason): void {
    // A click into the page is the person's own choice of where focus goes; a closed window has nowhere to put it.
    if (reason === 'blur' || reason === 'window-closed' || reason === 'replaced') return
    // An overlay that outlives tab switches (the restore bar) would otherwise return to the tab it was shown over.
    const before = reason === 'tab-switch' ? undefined : ownTarget(slot.returnTo)
    const target = before ?? deps.activeContents()
    if (target !== undefined && !target.isDestroyed()) target.focus()
  }

  function buildView (slot: Slot): OverlayViewHandle {
    let mine: OverlayViewHandle | undefined
    const current = (): boolean => mine !== undefined && slot.view === mine
    mine = createOverlayView({
      dirname: deps.dirname,
      def: slot.def,
      port: {
        ready: () => {
          if (!current()) return { shown: false }
          slot.pageReady = true
          slot.awaitingReply = true
          const waiting = slot.pending ?? Promise.resolve<OverlayReady>({ shown: false })
          slot.pending = null
          // The events go in the reply itself: sent beside it they could reach the page first, and a page that
          // resets on its first show would throw them away.
          return waiting.then((reply): OverlayReady => {
            if (!current()) return { shown: false }
            slot.awaitingReply = false
            if (!slot.open) return { shown: false }
            const events = slot.queued.splice(0)
            return events.length === 0 ? reply : { ...reply, events }
          })
        },
        request: (command) => current() ? slot.handler?.request(command) : undefined,
        size: (height) => {
          if (!current() || !slot.open) return
          slot.height = height
          slot.view?.setBounds(boundsFor(slot))
        },
        close: (reason) => { if (current()) closeSlot(slot, reason) }
      },
      onBlur: () => { if (current() && slot.open && slot.def.closeOn.blur) closeSlot(slot, 'blur') },
      onGone: () => { if (current()) discardView(slot) },
      // A click gave focus to a view that must never hold it: hand it straight back.
      onFocus: () => { if (current() && slot.open && slot.def.focus === 'never' && !slot.focusTaken) restoreFocus(slot, 'request') }
    })
    slot.view = mine
    slot.pageReady = false
    slot.awaitingReply = false
    slot.height = slot.def.height?.initial ?? DEFAULT_HEIGHT.initial
    return mine
  }

  const ensureView = (slot: Slot): OverlayViewHandle =>
    slot.view !== null && !slot.view.isDestroyed() ? slot.view : buildView(slot)

  /** A dead renderer is not a destroyed webContents, so `ensureView` would keep handing it out: close the slot and drop the view, and the next show or prewarm builds a fresh one. */
  function discardView (slot: Slot): void {
    closeSlot(slot, 'request')
    slot.view?.destroy()
    slot.view = null
    slot.pageReady = false
    slot.awaitingReply = false
    slot.pending = null
    slot.queued = []
  }

  function closeSlot (slot: Slot, reason: OverlayCloseReason): void {
    if (!slot.open) return
    slot.open = false
    openOrder = openOrder.filter((other) => other !== slot)
    slot.pending = null
    slot.queued = []
    slot.awaitingReply = false
    const view = slot.view
    if (view !== null && !view.isDestroyed()) {
      if (!disposed) view.detach(deps.contentView)
      recordPopoverShown(view.id, false)
    }
    if (reason === 'blur') slot.lastBlurCloseAt = Date.now()
    try { slot.handler?.closed?.(reason) } catch (error) { console.error('[overlay] closed hook failed', error) }
    // The hook may have shown this overlay again (the next of a queue): its view and focus are in use now.
    if (slot.open) return
    if (slot.def.keep === 'fresh' || disposed) {
      view?.destroy()
      slot.view = null
      slot.pageReady = false
    }
    if (slot.def.focus === 'take' || slot.focusTaken) restoreFocus(slot, reason)
    slot.focusTaken = false
    slot.returnTo = undefined
  }

  function closeOverlayPopups (except: Slot | undefined, reason: OverlayCloseReason): void {
    for (const slot of openSlots()) if (slot.def.layer === 'popup' && slot !== except) closeSlot(slot, reason)
  }

  function closePopups (except: Slot | undefined, reason: OverlayCloseReason): void {
    closeOverlayPopups(except, reason)
    for (const panel of adopted) panel.close()
  }

  function restack (): void {
    if (disposed) return
    for (const slot of openOrder.filter((other) => other.def.layer === 'bar')) slot.view?.attach(deps.contentView)
    for (const panel of adopted) {
      try { panel.restack?.() } catch (error) { console.error('[overlay] restacking an adopted panel failed', error) }
    }
    for (const slot of openOrder.filter((other) => other.def.layer === 'popup')) slot.view?.attach(deps.contentView)
  }

  function show (name: string, anchor?: OverlayAnchor, payload?: unknown): void {
    const slot = slots.get(name)
    if (slot === undefined || disposed) return
    // Read before a replaced popup closes: focus inside it belongs to whatever that popup itself was going to give it back to.
    const focused = focusedContents()
    const holder = focused === undefined ? undefined : openSlots().find((other) => other.view?.id === focused.id)
    const before = holder === undefined ? focused : holder.returnTo
    if (slot.def.layer === 'popup') closePopups(slot, 'replaced')
    const wasOpen = slot.open
    if (!wasOpen) slot.returnTo = ownTarget(before)
    const handler = handlerFor(slot)
    const view = ensureView(slot)
    // An anchor that is not a rectangle of numbers is not a place: keep the last good one.
    slot.anchor = isAnchor(anchor) ? anchor : slot.anchor
    slot.open = true
    if (!wasOpen) openOrder.push(slot)
    view.setBounds(boundsFor(slot))
    const result = showResult(handler, payload)
    // The handler runs at once, and may close this overlay or open another popup over it: nothing is left to attach then.
    if (!slot.open || slot.view !== view) return
    if (slot.pageReady) {
      void result.then((reply) => {
        if (slot.open && slot.view === view && reply.shown) view.send(OVERLAY_EVENT_CHANNEL, { type: 'show', payload: reply.payload })
      })
    } else {
      slot.pending = result
    }
    view.attach(deps.contentView)
    restack()
    recordPopoverShown(view.id, true)
    if (slot.def.focus === 'take' && !inBackground()) view.focusWhenReady(() => slot.open && slot.view === view)
  }

  function send (name: string, event: unknown): void {
    const slot = slots.get(name)
    if (slot === undefined || !slot.open || slot.view === null) return
    if (slot.pageReady && !slot.awaitingReply) slot.view.send(OVERLAY_EVENT_CHANNEL, { type: 'event', event })
    else if (slot.queued.length < QUEUE_LIMIT) slot.queued.push(event)
  }

  const unregisterTheme = onThemeUpdated(() => {
    for (const slot of slots.values()) slot.view?.refreshBackground()
  })

  return {
    show,
    toggle (name, anchor, payload) {
      const slot = slots.get(name)
      if (slot === undefined) return
      if (slot.open) { closeSlot(slot, 'request'); return }
      if (slot.def.closeOn.blur && Date.now() - slot.lastBlurCloseAt < REOPEN_DEBOUNCE_MS) return
      show(name, anchor, payload)
    },
    close (name) {
      if (name === undefined) { closePopups(undefined, 'request'); return }
      const slot = slots.get(name)
      if (slot !== undefined) closeSlot(slot, 'request')
    },
    isOpen: (name) => slots.get(name)?.open === true,
    prewarm (name) {
      const slot = slots.get(name)
      if (slot !== undefined && slot.def.keep === 'warm' && !disposed) ensureView(slot)
    },
    send,
    adopt: (panel, restackPanel) => { adopted.push({ close: () => { panel.close() }, restack: restackPanel }) },
    closeOverlays: () => { closeOverlayPopups(undefined, 'request') },
    tabSwitched: () => {
      for (const slot of openSlots()) if (slot.def.closeOn.tabSwitch) closeSlot(slot, 'tab-switch')
      for (const panel of adopted) panel.close()
    },
    navigated: () => { for (const slot of openSlots()) if (slot.def.closeOn.navigation) closeSlot(slot, 'navigation') },
    relayout () {
      for (const slot of openSlots()) {
        if (slot.def.closeOn.layout) closeSlot(slot, 'layout')
        else slot.view?.setBounds(boundsFor(slot))
      }
      for (const panel of adopted) panel.close()
    },
    restack,
    dispose () {
      if (disposed) return
      disposed = true
      unregisterTheme()
      for (const slot of openSlots()) closeSlot(slot, 'window-closed')
      for (const panel of adopted) panel.close()
      for (const slot of slots.values()) {
        try { slot.handler?.disposed?.() } catch (error) { console.error('[overlay] disposed hook failed', error) }
      }
      for (const slot of slots.values()) { slot.view?.destroy(); slot.view = null }
    }
  }
}
