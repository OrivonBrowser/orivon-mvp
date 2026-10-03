// What is on screen for the tabs: which views show, where, and which pane a
// press in a page chose. The tab collection decides which tab is in front;
// this puts the plan (./split-controller.ts) on the window through PaneHost.
import type { View, WebContentsView } from 'electron'
import { PaneHost } from './pane-host.js'
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

/** The window's PaneHost, plus the tab-aware calls that decide what it shows. */
export class TabPanes extends PaneHost {
  constructor (private readonly deps: TabPanesHost) {
    super(deps.contentView)
    this.onShownChange(() => { this.announce() })
  }

  /** Tells the lifecycle seam which of the window's tabs are on screen now (./tab-visibility.ts tells each page). */
  private announce (): void {
    const { deps } = this
    const lifecycle = deps.shell?.tabLifecycle
    if (lifecycle === undefined || deps.isClosing()) return
    const tabs = [...deps.records()].flatMap(([id, record]) => record.view.webContents.isDestroyed() ? [] : [{ contents: record.view.webContents, shown: this.isShown(id) }])
    lifecycle.shownChanged(deps.shell?.window, tabs)
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
    const backdrop = deps.shell?.backdrop
    if (plan.frame === null || backdrop === undefined) {
      this.show(panes)
      return
    }
    this.show(panes, { id: 'backdrop', view: backdrop.view, bounds: plan.frame.area })
    backdrop.update(plan.frame)
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
