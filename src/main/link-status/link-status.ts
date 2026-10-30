// The link bubble's behaviour for one window, with no Electron in it: which link it shows, in which corner, and when
// it goes. The overlay host is behind `LinkStatusPorts`, so the whole of it is driven by a fake clock in a unit test.
import { BUBBLE_MIN_WIDTH, bubbleInset, bubblePlace, bubbleRoom, bubbleWidth, hiddenBounds } from './bubble-geometry.js'
import type { PaneRect, WindowSize } from './bubble-geometry.js'
import { linkText } from './link-status-view.js'
import type { BubbleSide, LinkStatusView } from './link-status-view.js'
import type { OverlayAnchor } from '../overlays/overlay-types.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

/** How long a bubble outlives its link: the pointer crossing the gap between two links keeps one bubble instead of flickering. */
export const HIDE_DELAY_MS = 120

/** How long a bubble that took the other corner to get out of the pointer's way keeps it after it hid: the next link, pointed at a little later, would otherwise open it again under the pointer. */
export const SIDE_GRACE_MS = 1500

/** The tab a link is in. */
export interface LinkTab {
  readonly id: string
  /** The page area of the tab, or nothing while the tab is not on screen. Read when it is needed, never kept. */
  readonly pane: () => PaneRect | undefined
}

/** What the controller does to the world. */
export interface LinkStatusPorts {
  /** Opens the bubble's overlay at `bounds`, with the view its page draws. */
  show: (bounds: OverlayAnchor, view: LinkStatusView) => void
  /** Moves the open overlay. */
  place: (bounds: OverlayAnchor) => void
  /** Hands the open page a new view. */
  send: (view: LinkStatusView) => void
  /** Closes the overlay; the host then calls `closed`. */
  hide: () => void
  /** The window's content size, or nothing once the window is gone. */
  window: () => WindowSize | undefined
  /** A page holds the whole screen. */
  suppressed: () => boolean
}

interface Hover {
  readonly tab: LinkTab
  readonly text: string
  readonly seq: number
  /** The pane the bubble was made for: it is gone when its tab's pane is another. */
  readonly pane: PaneRect
  /** What its page measured the text to be, once it has. */
  width: number | undefined
}

const samePane = (a: PaneRect, b: PaneRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export class LinkStatus {
  private hover: Hover | undefined
  private open = false
  private side: BubbleSide = 'left'
  private seq = 0
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private sideTimer: ReturnType<typeof setTimeout> | undefined

  constructor (private readonly ports: LinkStatusPorts) {}

  isOpen (): boolean {
    return this.open
  }

  /** The page of `tab` says the pointer, or the keyboard, is on `url`, or on no link when it is empty. */
  hovered (tab: LinkTab, url: string): void {
    if (url === '') {
      // Another pane losing its link says nothing about the one the bubble is for.
      if (this.open && this.hover?.tab.id === tab.id) this.armHide()
      return
    }
    // The address as the address bar shows it, before it is cut: what a link says before an @ is not where it goes.
    const text = linkText(BUILTIN_ADDRESSES.displayUrl(url))
    const pane = tab.pane()
    const window = this.ports.window()
    if (window === undefined || this.ports.suppressed()) {
      this.hideNow()
      return
    }
    // A pane with no room, or no place on screen, is no reason to take the bubble of another pane down.
    if (pane === undefined || bubbleWidth(BUBBLE_MIN_WIDTH, pane) === undefined) {
      if (this.hover?.tab.id === tab.id) this.hideNow()
      return
    }
    const before = this.hover
    if (this.open && before?.tab.id === tab.id && !samePane(before.pane, pane)) this.hideNow()
    this.cancelHide()
    if (this.open && this.hover?.tab.id === tab.id && this.hover.text === text) return
    const hover: Hover = { tab, text, seq: ++this.seq, pane, width: undefined }
    this.hover = hover
    const view = this.viewFor(hover, pane, window)
    if (!this.open) {
      this.open = true
      this.cancelSideGrace()
      this.ports.show(hiddenBounds(pane, this.side), view)
      return
    }
    // Another pane's corner: the bubble leaves the old one now and takes the new one when the text is measured.
    if (before?.tab.id !== tab.id) this.ports.place(hiddenBounds(pane, this.side))
    this.ports.send(view)
  }

  /** The page measured the text of view `seq` as `width` pixels. */
  width (seq: number, width: number): void {
    const hover = this.hover
    if (!this.open || hover === undefined || seq !== hover.seq) return
    const place = this.placeFor(hover, width)
    if (place === undefined) return
    hover.width = width
    this.ports.place(place)
  }

  /** The pointer entered the bubble: it takes the other corner, where it stays until it has hidden. */
  pointerEntered (): void {
    const hover = this.hover
    if (!this.open || hover === undefined || this.side === 'right') return
    this.side = 'right'
    const pane = hover.tab.pane()
    const window = this.ports.window()
    if (pane === undefined || window === undefined || !samePane(hover.pane, pane)) { this.hideNow(); return }
    if (hover.width !== undefined) {
      const place = this.placeFor(hover, hover.width)
      if (place === undefined) return
      this.ports.place(place)
    }
    this.ports.send(this.viewFor(hover, pane, window))
  }

  /** The tab navigated or died: its bubble goes at once. */
  left (tabId: string): void {
    if (this.hover?.tab.id === tabId) this.hideNow()
  }

  /** Something changed in how the tabs are laid out (a split opened or closed, the panes swapped, a tab went behind): the bubble goes when its tab's pane is not the one it was made for. */
  checkPane (): void {
    const hover = this.hover
    if (!this.open || hover === undefined) return
    const pane = hover.tab.pane()
    if (pane === undefined || !samePane(hover.pane, pane)) this.hideNow()
  }

  /** The host closed the overlay, for any reason. A bubble that had taken the other corner keeps it a moment (`SIDE_GRACE_MS`). */
  closed (): void {
    this.cancelHide()
    this.open = false
    this.hover = undefined
    this.cancelSideGrace()
    if (this.side === 'right') this.sideTimer = setTimeout(() => { this.sideTimer = undefined; this.side = 'left' }, SIDE_GRACE_MS)
    else this.side = 'left'
  }

  dispose (): void {
    this.closed()
    this.cancelSideGrace()
  }

  private viewFor (hover: Hover, pane: PaneRect, window: WindowSize): LinkStatusView {
    const { left, right } = bubbleInset(pane, window, this.side)
    return { seq: hover.seq, text: hover.text, side: this.side, room: bubbleRoom(pane) ?? BUBBLE_MIN_WIDTH, inset: { left, right } }
  }

  /** Where the bubble goes at `width`; hides it when there is no longer a place. */
  private placeFor (hover: Hover, width: number): OverlayAnchor | undefined {
    const pane = hover.tab.pane()
    const window = this.ports.window()
    const place = pane === undefined || window === undefined ? undefined : bubblePlace(pane, window, this.side, width)
    if (place === undefined) this.hideNow()
    return place?.bounds
  }

  private armHide (): void {
    if (this.hideTimer !== undefined) return
    this.hideTimer = setTimeout(() => { this.hideTimer = undefined; this.hideNow() }, HIDE_DELAY_MS)
  }

  private cancelHide (): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer)
    this.hideTimer = undefined
  }

  private cancelSideGrace (): void {
    if (this.sideTimer !== undefined) clearTimeout(this.sideTimer)
    this.sideTimer = undefined
  }

  private hideNow (): void {
    this.cancelHide()
    if (!this.open) return
    this.ports.hide()
    this.closed()
  }
}
