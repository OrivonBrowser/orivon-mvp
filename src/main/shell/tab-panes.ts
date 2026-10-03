// What is on screen for the tabs: which views show, where, and which pane a
// press in a page chose. The tab collection decides which tab is in front;
// this puts the plan (./split-controller.ts) on the window through PaneHost.
import type { View, WebContentsView } from 'electron'
import { whenPainted } from './first-paint.js'
import { PaneHost } from './pane-host.js'
import type { LayoutSizeOf } from './pane-host.js'
import type { SplitController } from './split-controller.js'
import type { Bounds, TabRecord, TabShell } from './tab-types.js'

export interface TabPanesHost {
  readonly contentView: View
  readonly splits: SplitController
  readonly record: (id: string) => TabRecord | undefined
  readonly records: () => Iterable<readonly [string, TabRecord]>
  readonly activeId: () => string | null
  readonly setActiveId: (id: string) => void
  readonly area: () => Bounds
  readonly isClosing: () => boolean
  readonly emitState: () => void
  readonly shell: TabShell | undefined
}

/** The size, in view pixels, a tab's page lays itself out at (its CSS size times the page zoom). */
const pageLayoutSize: LayoutSizeOf = async (view) => {
  try {
    const contents = (view as WebContentsView).webContents
    if (contents.isDestroyed()) return null
    const css: unknown = await contents.executeJavaScript('[window.innerWidth, window.innerHeight]')
    if (!Array.isArray(css) || typeof css[0] !== 'number' || typeof css[1] !== 'number') return null
    const zoom = contents.getZoomFactor()
    return { width: Math.round(css[0] * zoom), height: Math.round(css[1] * zoom) }
  } catch {
    return null
  }
}

/** The window's PaneHost, plus the tab-aware calls that decide what it shows. */
export class TabPanes extends PaneHost {
  /** The tab whose new-tab page is drawing its first frame while the page that was in front stays on screen. */
  private revealing: { readonly id: string, readonly view: WebContentsView } | null = null
  /** Views whose page has drawn (or was given up on): a new-tab page is held for only once. */
  private readonly drawn = new WeakSet<View>()

  constructor (private readonly deps: TabPanesHost) {
    super(deps.contentView, pageLayoutSize)
  }

  /** Shows `view` for a tab whose view was swapped, in the tab's pane. */
  swap (id: string, view: WebContentsView): void {
    this.replace(id, view, this.bounds(id))
  }

  idOfView (view: WebContentsView): string {
    for (const [id, record] of this.deps.records()) if (record.view === view) return id
    return ''
  }

  /** The tab holding the whole window (`HtmlFullscreen`'s answer, ../fullscreen.ts), only while still in front. */
  get fullscreenId (): string | null {
    const id = this.deps.shell?.fullscreenTabId?.() ?? null
    return id === this.deps.activeId() ? id : null
  }

  /** Puts the views on screen as the plan says: the tab in front, or the two panes of a split, sized. */
  sync (): void {
    const { deps } = this
    if (deps.isClosing()) return
    const plan = deps.splits.plan(deps.activeId(), deps.area(), this.fullscreenId)
    const panes = plan.panes.flatMap(({ id, bounds }) => {
      const view = deps.record(id)?.view
      return view === undefined || view.webContents.isDestroyed() ? [] : [{ id, view, bounds }]
    })
    this.holdForFirstPaint(panes)
    const backdrop = deps.shell?.backdrop
    if (plan.frame === null || backdrop === undefined) {
      this.show(panes)
      return
    }
    this.show(panes, { id: 'backdrop', view: backdrop.view, bounds: plan.frame.area })
    backdrop.update(plan.frame)
  }

  /** A new-tab page coming to the screen: its view is created before its renderer has started, and shows its own
   * colour until the page draws. Nothing is taken off the screen until it has drawn, so the person goes from the
   * page they were on to the finished new tab, never through a blank one. Only a view that is new to the screen and
   * has never drawn is held for, and only while it is still wanted: any other plan ends the wait. */
  private holdForFirstPaint (panes: readonly { readonly id: string, readonly view: WebContentsView }[]): void {
    if (this.revealing !== null && panes.every((pane) => pane.view !== this.revealing?.view)) this.finishReveal(this.revealing.view)
    if (this.revealing !== null) return
    const fresh = panes.find((pane) => !this.isShown(pane.id) && !this.drawn.has(pane.view) && this.deps.record(pane.id)?.isDashboardTab === true)
    if (fresh === undefined) return
    this.drawn.add(fresh.view)
    if (!this.anyShown) return
    this.revealing = { id: fresh.id, view: fresh.view }
    this.hold()
    void whenPainted(fresh.view.webContents).then(() => { this.finishReveal(fresh.view) })
  }

  private finishReveal (view: WebContentsView): void {
    if (this.revealing?.view !== view) return
    this.revealing = null
    this.release()
  }

  /** Where a tab's view goes now: its pane, or the whole area. */
  bounds (id: string): Bounds {
    const { deps } = this
    return deps.splits.plan(deps.activeId(), deps.area(), this.fullscreenId).panes.find((pane) => pane.id === id)?.bounds ?? deps.area()
  }

  /** The person pressed in a page. Of two panes, that is the one they are in. */
  clicked (id: string): void {
    const { deps } = this
    if (id === deps.activeId() || deps.splits.groups.partnerOf(id) !== deps.activeId()) return
    deps.setActiveId(id)
    this.sync()
    deps.emitState()
  }
}
