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
    // A lone pane (the ordinary, undivided case) is appended with no index: nothing else occupies
    // its bounds, so where it lands among `contentView`'s children has never mattered. Once there is
    // a backdrop or a second pane the order matters, and a new pane goes where `slotFor` says.
    const ordered = panes.length > 1 || nextBackdrop !== null
    panes.forEach((pane, at) => {
      if (this.shown.get(pane.id) !== pane.view) {
        if (ordered) this.contentView.addChildView(pane.view, this.slotFor(panes, at, nextBackdrop))
        else this.contentView.addChildView(pane.view)
        this.shown.set(pane.id, pane.view)
      }
      pane.view.setBounds(pane.bounds)
    })
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
