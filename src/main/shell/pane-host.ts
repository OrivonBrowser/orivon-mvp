// What is on screen in the window's content area: the view of each pane, and
// behind them, when there are two, a backdrop that draws the divider. Sizes and
// stacks them; deciding which panes there are is the tab collection's.
import type { View } from 'electron'
import { attachShown, showAgain } from './attach-view.js'
import type { Bounds } from './tab-types.js'

export interface PaneView {
  readonly id: string
  readonly view: View
  readonly bounds: Bounds
}

/** The size, in view pixels, the page in `view` lays itself out at; `null` when that cannot be read. */
export type LayoutSizeOf = (view: View) => Promise<{ width: number, height: number } | null>

/** Whether the page in `view` reads `visible`; `null` when that cannot be read. */
export type PageShownOf = (view: View) => Promise<boolean | null>

/** How long after a pane goes on screen its page's layout is checked, and the longest the check may be one pixel off. */
const SETTLE_MS = 250
const SETTLE_TOLERANCE_PX = 2
const SETTLE_TRIES = 3
const NUDGE_MS = 80
/** A page that commits a document is left with its neighbour pane hidden about ten milliseconds later (measured on Electron 44). */
const MEND_MS = 60
const MEND_TRIES = 3

export class PaneHost {
  private readonly shown = new Map<string, View>()
  private readonly placed = new Map<string, Bounds>()
  /** Views of tabs that left the screen but stay in the window, hidden, while `keepAttached` says so (a tab being shared). */
  private readonly kept = new Map<string, View>()
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>()
  private mending: ReturnType<typeof setTimeout> | undefined
  private backdrop: View | null = null
  private readonly changeListeners = new Set<() => void>()

  /** `layoutSizeOf`, when given, lets a pane that went on screen be checked against its bounds (`settle`); `pageShownOf`, that
   * each pane on screen is shown (`mend`). `keepAttached` names a view that is to stay in the window, hidden, when its tab is no
   * longer in front: Chromium captures only a view that is in a window. */
  constructor (
    private readonly contentView: View,
    private readonly layoutSizeOf?: LayoutSizeOf,
    private readonly pageShownOf?: PageShownOf,
    private readonly keepAttached?: (view: View) => boolean
  ) {}

  /** Called after a change to which tabs are on screen (not after a pane is only resized). Returns the removal. */
  onShownChange (listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  private shownChanged (): void {
    for (const listener of this.changeListeners) listener()
  }

  /** Shows exactly these panes, sized, with `backdrop` behind them when there is one.
   *
   * Never touches a pane that is already on screen under the same view: this call also runs on
   * every `layoutAll` (a window resize), which shares `contentView` with the welcome screen, the
   * fullscreen/pointer-lock notice and the toolbar popovers, so re-adding an unchanged pane here
   * would raise it above whichever of those is currently showing. Electron 44's `addChildView`
   * only reorders an already-attached view to the top rather than detaching it first (never
   * losing a frame), but that reorder itself is the bug this guards against -- so a pane keeps
   * its place unless it is genuinely new to the screen or its view changed. */
  show (panes: readonly PaneView[], backdrop: PaneView | null = null): void {
    const wanted = new Map(panes.map((pane) => [pane.id, pane.view]))
    let changed = false
    for (const [id, view] of this.shown) {
      if (wanted.get(id) === view) continue
      this.leave(id, view)
      this.forget(id)
      changed = true
    }
    const nextBackdrop = backdrop?.view ?? null
    if (this.backdrop !== nextBackdrop) {
      if (this.backdrop !== null) this.contentView.removeChildView(this.backdrop)
      // At index 0, the bottom: `contentView` is the window's own content view, and the chrome
      // (toolbar) view is added to it once, first, before any pane ever is (window.ts) -- so
      // index 0 only ever displaces panes and popovers, never the chrome, and stays below all of
      // them regardless of how many times a backdrop comes and goes.
      if (nextBackdrop !== null) attachShown(this.contentView, nextBackdrop, 0)
      this.backdrop = nextBackdrop
    }
    if (backdrop !== null) backdrop.view.setBounds(backdrop.bounds)
    // A lone pane (the ordinary, undivided case) is appended with no index: nothing else occupies
    // its bounds, so where it lands among `contentView`'s children has never mattered. Once there is
    // a backdrop or a second pane the order matters, and a new pane goes where `slotFor` says.
    const ordered = panes.length > 1 || nextBackdrop !== null
    let attached = false
    panes.forEach((pane, at) => {
      if (this.shown.get(pane.id) !== pane.view) {
        this.dropKept(pane.id, pane.view)
        attached = true
        attachShown(this.contentView, pane.view, ordered ? this.slotFor(panes, at, nextBackdrop) : undefined, this.onScreenOver(panes.slice(at + 1).map((other) => other.view)))
        this.shown.set(pane.id, pane.view)
        changed = true
        this.settle(pane.id, pane.view, SETTLE_TRIES)
      }
      this.placed.set(pane.id, pane.bounds)
      pane.view.setBounds(pane.bounds)
    })
    if (attached && panes.length > 1) this.mend(MEND_TRIES)
    if (changed) this.shownChanged()
  }

  /** Two panes side by side can leave one hidden while the other is shown: a page that commits a document, or a pane put
   * below its neighbour, hides the page under it. Shortly after, each pane is asked whether its page is shown, and the
   * panes beside one that is not are hidden and shown again. Costs one read per pane, only while there are two. */
  private mend (tries: number): void {
    const { pageShownOf } = this
    clearTimeout(this.mending)
    if (pageShownOf === undefined || tries === 0 || this.shown.size < 2) return
    this.mending = setTimeout(() => {
      const panes = [...this.shown]
      void Promise.all(panes.map(async ([, view]) => await pageShownOf(view))).then((answers) => {
        const now = [...this.shown]
        if (now.length !== panes.length || now.some(([id, view], at) => panes[at]?.[0] !== id || panes[at]?.[1] !== view)) return
        let mended = false
        answers.forEach((shown, at) => {
          if (shown !== false) return
          const view = panes[at]?.[1]
          if (view === undefined) return
          showAgain(this.contentView, view, panes.filter(([, other]) => other !== view).map(([, other]) => other))
          mended = true
        })
        if (mended) this.mend(tries - 1)
      })
    }, MEND_MS)
  }

  /** A view going off the screen: out of the window, or hidden in it while it is to stay attached. A hidden attached view
   * still paints, which is what a capture of it needs, so this ends with `releaseKept` once nothing needs it. */
  private leave (id: string, view: View): void {
    if (this.keepAttached?.(view) === true) {
      view.setVisible(false)
      this.kept.set(id, view)
    } else {
      this.contentView.removeChildView(view)
    }
  }

  /** The kept view of `id`, taken out of the window unless it is `except`, the view about to be shown again. */
  private dropKept (id: string, except?: View): void {
    const view = this.kept.get(id)
    if (view === undefined) return
    this.kept.delete(id)
    if (view !== except) this.contentView.removeChildView(view)
  }

  /** Takes out of the window every kept view that nothing needs any more: a share ended. */
  releaseKept (): void {
    for (const [id, view] of [...this.kept]) {
      if (this.keepAttached?.(view) !== true) this.dropKept(id)
    }
  }

  /** Of `views`, those on screen now: the ones a view put below them must be shown beside. */
  private onScreenOver (views: readonly View[]): View[] {
    return views.filter((view) => this.contentView.children.includes(view))
  }

  private forget (id: string): void {
    this.shown.delete(id)
    this.placed.delete(id)
    clearTimeout(this.settling.get(id))
    this.settling.delete(id)
  }

  /** A page that was captured while it was behind another can be put on screen and keep laying itself
   * out at the size it had before, so its pane shows a clipped or empty page, and a bounds change that
   * arrives at once does not reach it. Shortly after a pane is put on screen the size its page lays out
   * at is read; when it is not the pane's, the view is made one pixel wider and put back, a change the
   * page does take. Costs one read of two numbers per pane put on screen. */
  private settle (id: string, view: View, tries: number): void {
    const { layoutSizeOf } = this
    if (layoutSizeOf === undefined || tries === 0) return
    clearTimeout(this.settling.get(id))
    this.settling.set(id, setTimeout(() => {
      this.settling.delete(id)
      void layoutSizeOf(view).then((size) => {
        const bounds = this.placed.get(id)
        if (this.shown.get(id) !== view || bounds === undefined || size === null) return
        if (Math.abs(size.width - bounds.width) <= SETTLE_TOLERANCE_PX && Math.abs(size.height - bounds.height) <= SETTLE_TOLERANCE_PX) return
        view.setBounds({ ...bounds, width: bounds.width + 1 })
        this.settling.set(id, setTimeout(() => {
          this.settling.delete(id)
          if (this.shown.get(id) !== view) return
          view.setBounds(this.placed.get(id) ?? bounds)
          this.settle(id, view, tries - 1)
        }, NUDGE_MS))
      })
    }, SETTLE_MS))
  }

  /** Where in `contentView.children` the new pane `panes[at]` goes, so a split's panes keep the order
   * `panes` gives them even when only one is new. The index is read off the children as they are now,
   * not counted among this host's own views: the chrome, the popovers, the notice and the welcome
   * screen share the list, and the ones appended after the partner went in sit above it. A new pane
   * lands right after the pane before it, else right before the pane after it, else on the backdrop
   * -- always below everything appended since, so no popover is ever covered. */
  private slotFor (panes: readonly PaneView[], at: number, backdrop: View | null): number | undefined {
    const siblings = this.contentView.children
    for (let before = at - 1; before >= 0; before -= 1) {
      const view = this.shown.get(panes[before]?.id ?? '')
      const index = view === undefined ? -1 : siblings.indexOf(view)
      if (index !== -1) return index + 1
    }
    for (let after = at + 1; after < panes.length; after += 1) {
      const view = this.shown.get(panes[after]?.id ?? '')
      const index = view === undefined ? -1 : siblings.indexOf(view)
      if (index !== -1) return index
    }
    const base = backdrop === null ? -1 : siblings.indexOf(backdrop)
    return base === -1 ? undefined : base + 1
  }

  isShown (id: string): boolean {
    return this.shown.has(id)
  }

  /** Takes a tab's view off the screen (it is going away, or being swapped for another). */
  hide (id: string): void {
    this.dropKept(id)
    if (this.takeOff(id)) this.shownChanged()
  }

  /** `hide` without the announcement, for a view that `replace` puts another in the place of at once. Whether a pane
   * was on screen. */
  takeOff (id: string): boolean {
    this.dropKept(id)
    const view = this.shown.get(id)
    if (view === undefined) return false
    this.contentView.removeChildView(view)
    this.forget(id)
    return true
  }

  /** Shows `view` for a pane that is on screen already under another view, in the same place: the old view's
   * slot among `contentView`'s children, never on top, so a popover open above the pane stays above it and a
   * split's panes keep their order. The new view's page is checked against the bounds like any pane put on screen. */
  replace (id: string, view: View, bounds: Bounds): void {
    const old = this.shown.get(id)
    const index = old === undefined ? -1 : this.contentView.children.indexOf(old)
    this.takeOff(id)
    attachShown(this.contentView, view, index === -1 ? undefined : index, this.onScreenOver([...this.shown].filter(([other]) => other !== id).map(([, other]) => other)))
    this.shown.set(id, view)
    this.placed.set(id, bounds)
    view.setBounds(bounds)
    this.settle(id, view, SETTLE_TRIES)
    this.mend(MEND_TRIES)
    this.shownChanged()
  }

  /** A pane's page committed a new document, which can give it a fresh renderer view that lays itself out at a
   * size other than the pane's: the same check as for a pane just put on screen. Only while there are two panes,
   * where a view that is not the whole area can be told a size it already has. */
  recheck (id: string): void {
    const view = this.shown.get(id)
    if (view === undefined || this.shown.size < 2) return
    this.settle(id, view, SETTLE_TRIES)
    this.mend(MEND_TRIES)
  }
}
