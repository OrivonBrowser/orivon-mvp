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

/** The size, in view pixels, the page in `view` lays itself out at; `null` when that cannot be read. */
export type LayoutSizeOf = (view: View) => Promise<{ width: number, height: number } | null>

/** How long after a pane goes on screen its page's layout is checked, and the longest the check may be one pixel off. */
const SETTLE_MS = 250
const SETTLE_TOLERANCE_PX = 2
const SETTLE_TRIES = 3
const NUDGE_MS = 80
const BACKDROP = 'backdrop'

export class PaneHost {
  private readonly shown = new Map<string, View>()
  private readonly placed = new Map<string, Bounds>()
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>()
  private backdrop: View | null = null
  private readonly changeListeners = new Set<() => void>()
  /** While `holding`: the views of panes that left the plan but stay attached, under whatever is new, by pane id ('backdrop' for the backdrop). */
  private readonly held = new Map<string, View>()
  private holding = false

  /** `layoutSizeOf`, when given, lets a pane that went on screen be checked against its bounds (`settle`). */
  constructor (private readonly contentView: View, private readonly layoutSizeOf?: LayoutSizeOf) {}

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
    // A pane that is wanted again while its view is still attached under a hold goes back to being shown, in place.
    for (const [id, view] of this.held) {
      if (id === BACKDROP || wanted.get(id) !== view) continue
      this.held.delete(id)
      this.shown.set(id, view)
      changed = true
    }
    for (const [id, view] of this.shown) {
      if (wanted.get(id) === view) continue
      if (this.holding) this.held.set(id, view)
      else this.contentView.removeChildView(view)
      this.forget(id)
      changed = true
    }
    const nextBackdrop = backdrop?.view ?? null
    if (this.backdrop !== nextBackdrop) {
      if (this.backdrop !== null) {
        if (this.holding) this.held.set(BACKDROP, this.backdrop)
        else this.contentView.removeChildView(this.backdrop)
      }
      // At index 0, the bottom: `contentView` is the window's own content view, and the chrome
      // (toolbar) view is added to it once, first, before any pane ever is (window.ts) -- so
      // index 0 only ever displaces panes and popovers, never the chrome, and stays below all of
      // them regardless of how many times a backdrop comes and goes.
      if (nextBackdrop !== null) {
        if (this.held.get(BACKDROP) === nextBackdrop) this.held.delete(BACKDROP)
        this.contentView.addChildView(nextBackdrop, 0)
      }
      this.backdrop = nextBackdrop
    }
    if (backdrop !== null) backdrop.view.setBounds(backdrop.bounds)
    // A lone pane (the ordinary, undivided case) is appended with no index: nothing else occupies
    // its bounds, so where it lands among `contentView`'s children has never mattered. Once there is
    // a backdrop or a second pane the order matters, and a new pane goes where `slotFor` says.
    const ordered = panes.length > 1 || nextBackdrop !== null
    panes.forEach((pane, at) => {
      if (this.shown.get(pane.id) !== pane.view) {
        const underHeld = this.lowestHeld()
        if (underHeld !== undefined) this.contentView.addChildView(pane.view, underHeld)
        else if (ordered) this.contentView.addChildView(pane.view, this.slotFor(panes, at, nextBackdrop))
        else this.contentView.addChildView(pane.view)
        this.shown.set(pane.id, pane.view)
        changed = true
        this.settle(pane.id, pane.view, SETTLE_TRIES)
      }
      this.placed.set(pane.id, pane.bounds)
      pane.view.setBounds(pane.bounds)
    })
    if (changed) this.shownChanged()
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

  /** From now until `release`, a pane that leaves the plan stays attached, and a pane that joins it is
   * attached under those: the page in front keeps the screen while the new page's renderer starts, and
   * the new view still paints below it (a detached view does not). Used for a page that has not painted
   * yet; the caller releases once it has. */
  hold (): void {
    this.holding = true
  }

  /** Ends `hold`: takes off the screen the views it kept. The panes that joined stay where they went in. */
  release (): void {
    this.holding = false
    for (const view of this.held.values()) this.contentView.removeChildView(view)
    this.held.clear()
  }

  private lowestHeld (): number | undefined {
    if (this.held.size === 0) return undefined
    const siblings = this.contentView.children
    const at = [...this.held.values()].map((view) => siblings.indexOf(view)).filter((index) => index !== -1)
    return at.length === 0 ? undefined : Math.min(...at)
  }

  /** Whether any pane is on screen now (a held one is not). */
  get anyShown (): boolean {
    return this.shown.size > 0
  }

  isShown (id: string): boolean {
    return this.shown.has(id)
  }

  /** Takes a tab's view off the screen (it is going away, or being swapped for another). */
  hide (id: string): void {
    if (this.release(id)) this.shownChanged()
  }

  /** `hide` without the announcement, for a view that `replace` puts another in the place of at once. Whether a pane
   * on screen left it: a held view was already off the plan. */
  release (id: string): boolean {
    const view = this.shown.get(id) ?? this.held.get(id)
    if (view === undefined) return false
    const wasShown = this.shown.has(id)
    this.contentView.removeChildView(view)
    this.forget(id)
    this.held.delete(id)
    return wasShown
  }

  /** Shows `view` for a pane that is on screen already under another view, in the same place. */
  replace (id: string, view: View, bounds: Bounds): void {
    const old = this.shown.get(id)
    const index = old === undefined ? -1 : this.contentView.children.indexOf(old)
    this.release(id)
    // At the old view's place, never on top: a popover open above the pane stays above it.
    if (index === -1) this.contentView.addChildView(view)
    else this.contentView.addChildView(view, index)
    this.shown.set(id, view)
    this.placed.set(id, bounds)
    view.setBounds(bounds)
    this.shownChanged()
  }
}
