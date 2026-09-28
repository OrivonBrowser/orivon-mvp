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

  /** Shows exactly these panes, sized, with `backdrop` behind them when there is one. */
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
      if (nextBackdrop !== null) {
        // Under every pane: those already on screen come off, and go back on above it.
        for (const view of this.shown.values()) this.contentView.removeChildView(view)
        this.shown.clear()
        this.contentView.addChildView(nextBackdrop)
      }
      this.backdrop = nextBackdrop
    }
    if (backdrop !== null) backdrop.view.setBounds(backdrop.bounds)
    for (const pane of panes) {
      if (this.shown.get(pane.id) !== pane.view) {
        this.contentView.addChildView(pane.view)
        this.shown.set(pane.id, pane.view)
      }
      pane.view.setBounds(pane.bounds)
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
