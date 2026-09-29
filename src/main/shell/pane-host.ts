// What is on screen in the window's content area: the view of each pane, and
// behind them, when there are two, a backdrop that draws the divider. Sizes and
// stacks them; deciding which panes there are is the tab collection's.
import type { View } from 'electron'
import type { Bounds } from './tab-types.js'

export interface PaneView {
  readonly id: string
  readonly view: View
  readonly bounds: Bounds
}

export class PaneHost {
  private readonly shown = new Map<string, View>()
  private backdrop: View | null = null

  constructor (private readonly contentView: View) {}

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
    for (const [id, view] of this.shown) {
      if (wanted.get(id) === view) continue
      this.contentView.removeChildView(view)
      this.shown.delete(id)
    }
    const nextBackdrop = backdrop?.view ?? null
    if (this.backdrop !== nextBackdrop) {
      if (this.backdrop !== null) this.contentView.removeChildView(this.backdrop)
      // At index 0, the bottom: `contentView` is the window's own content view, and the chrome
      // (toolbar) view is added to it once, first, before any pane ever is (window.ts) -- so
      // index 0 only ever displaces panes and popovers, never the chrome, and stays below all of
      // them regardless of how many times a backdrop comes and goes.
      if (nextBackdrop !== null) this.contentView.addChildView(nextBackdrop, 0)
      this.backdrop = nextBackdrop
    }
    if (backdrop !== null) backdrop.view.setBounds(backdrop.bounds)
    // A lone pane (the ordinary, undivided case) is appended with no index, exactly as before --
    // where it lands relative to whatever else is on `contentView` has never mattered, since
    // nothing else occupies its bounds. Only once there is a backdrop, or more than one pane, does
    // the order among them matter (a split's two panes side by side): a genuinely new pane there
    // goes right after the backdrop (if any) and every pane before it in `panes` -- an index
    // counted purely among this host's own views, never the popovers/notice sharing `contentView`,
    // which only ever append themselves with no index of their own (an insert at a low index never
    // changes any of their relative order to one another, only shifts their numeric position).
    // Keeps a split's two panes in the order `panes` gives them even when only one of the two is
    // new -- Electron would otherwise put it above its partner, which an unconditional re-add of
    // every pane used to fix as a side effect of raising both.
    const ordered = panes.length > 1 || nextBackdrop !== null
    let index = nextBackdrop !== null ? 1 : 0
    for (const pane of panes) {
      if (this.shown.get(pane.id) !== pane.view) {
        if (ordered) this.contentView.addChildView(pane.view, index)
        else this.contentView.addChildView(pane.view)
        this.shown.set(pane.id, pane.view)
      }
      pane.view.setBounds(pane.bounds)
      index += 1
    }
  }

  isShown (id: string): boolean {
    return this.shown.has(id)
  }

  /** Takes a tab's view off the screen (it is going away, or being swapped for another). */
  hide (id: string): void {
    const view = this.shown.get(id)
    if (view === undefined) return
    this.contentView.removeChildView(view)
    this.shown.delete(id)
  }

  /** Shows `view` for a pane that is on screen already under another view, in the same place. */
  replace (id: string, view: View, bounds: Bounds): void {
    this.hide(id)
    this.contentView.addChildView(view)
    this.shown.set(id, view)
    view.setBounds(bounds)
  }
}
