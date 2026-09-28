// Split view for one window: which tabs are joined, what a drag over the page
// shows, and where each view goes. It holds the groups (./split-model.ts) and
// works the tab strip through the small interface the collection gives it; it
// knows nothing of views.
import { MARGIN, SplitGroups, isFirstPane, orientationOf, paneRects, ratioAt, zoneHalf } from './split-model.js'
import type { Orientation, PaneRects, Zone } from './split-model.js'
import type { Bounds } from './tab-types.js'

/** What the backdrop behind two panes draws. */
export interface FrameState {
  readonly area: Bounds
  readonly orientation: Orientation
  /** Where the divider is, for the pointer to grab. Absent while a tab is being dragged over the page. */
  readonly divider: Bounds | null
  readonly panes: { readonly a: Bounds, readonly b: Bounds } | null
  /** Which pane the person is in. */
  readonly active: 'a' | 'b' | null
  /** Where a tab dropped now would go. */
  readonly placeholder: Bounds | null
}

export interface Plan {
  readonly panes: ReadonlyArray<{ readonly id: string, readonly bounds: Bounds }>
  /** Null when one pane fills the area and nothing is drawn behind it. */
  readonly frame: FrameState | null
}

export interface SplitHost {
  /** The strip, live: this reorders it. */
  readonly order: string[]
  activate: (id: string) => void
  /** The panes or their sizes changed: put the views right and tell the chrome. */
  changed: () => void
  /** A tab that holds nothing, opened for a split; returns its id. */
  openTab: () => string
  /** The area the panes share. */
  area: () => Bounds
}

const inset = (bounds: Bounds): Bounds => ({ x: bounds.x + MARGIN, y: bounds.y + MARGIN, width: bounds.width - 2 * MARGIN, height: bounds.height - 2 * MARGIN })

export class SplitController {
  readonly groups = new SplitGroups()
  private preview: { zone: Zone } | null = null

  constructor (private readonly host: SplitHost) {}

  /** What to show, given the tab the person is in. `fullscreenId`: a page has the whole area, and nothing else shows. */
  plan (activeId: string | null, area: Bounds, fullscreenId: string | null): Plan {
    if (fullscreenId !== null) return { panes: [{ id: fullscreenId, bounds: area }], frame: null }
    if (activeId === null) return { panes: [], frame: null }
    if (this.preview !== null) return this.previewPlan(activeId, area, this.preview.zone)
    const group = this.groups.groupOf(activeId)
    const rects: PaneRects | null = group === undefined ? null : paneRects(area, group.orientation, group.ratio)
    if (group === undefined || rects === null) return { panes: [{ id: activeId, bounds: area }], frame: null }
    return {
      panes: [{ id: group.a, bounds: rects.a }, { id: group.b, bounds: rects.b }],
      frame: { area, orientation: group.orientation, divider: rects.divider, panes: { a: rects.a, b: rects.b }, active: group.a === activeId ? 'a' : 'b', placeholder: null }
    }
  }

  /** While a tab is dragged over an edge: the current page shrinks to the other half, and the drop half is marked. */
  private previewPlan (activeId: string, area: Bounds, zone: Zone): Plan {
    const drop = zoneHalf(area, zone)
    const keep = zoneHalf(area, ({ left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const)[zone])
    return {
      panes: [{ id: activeId, bounds: inset(keep) }],
      frame: { area, orientation: orientationOf(zone), divider: null, panes: null, active: null, placeholder: inset(drop) }
    }
  }

  /** Shows the drop half for `zone`, or nothing for null. */
  setPreview (zone: Zone | null): void {
    if ((this.preview?.zone ?? null) === zone) return
    this.preview = zone === null ? null : { zone }
    this.host.changed()
  }

  get previewing (): boolean {
    return this.preview !== null
  }

  /** Puts `dropped` in the pane `zone` names beside `existing`, and goes to it. False when the two cannot be joined. */
  split (existing: string, dropped: string, zone: Zone): boolean {
    const order = this.host.order
    if (existing === dropped || !order.includes(existing) || !order.includes(dropped)) return false
    this.preview = null
    this.groups.separate(existing)
    this.groups.separate(dropped)
    const [a, b] = isFirstPane(zone) ? [dropped, existing] : [existing, dropped]
    if (!this.groups.create(a, b, orientationOf(zone))) return false
    this.placeTogether(a, b)
    this.host.activate(dropped)
    return true
  }

  /** Joins the tab with the next one (else the one before, else a new tab), or breaks the group it is in. */
  toggle (id: string): void {
    if (this.groups.groupOf(id) !== undefined) {
      this.separate(id)
      return
    }
    const order = this.host.order
    const after = order.slice(order.indexOf(id) + 1).find((other) => this.groups.groupOf(other) === undefined)
    const before = order.slice(0, order.indexOf(id)).reverse().find((other) => this.groups.groupOf(other) === undefined)
    const existing = after ?? before
    const partner = existing ?? this.host.openTab()
    this.split(id, partner, 'right')
    // The person stays where they were, unless the other pane is a new page they will want to use.
    if (existing !== undefined) this.host.activate(id)
  }

  separate (id: string): void {
    this.groups.separate(id)
    this.host.changed()
  }

  swap (id: string): void {
    const group = this.groups.groupOf(id)
    if (group === undefined) return
    this.groups.swap(id)
    this.placeTogether(group.a, group.b)
    this.host.changed()
  }

  rotate (id: string): void {
    this.groups.rotate(id)
    this.host.changed()
  }

  setRatio (id: string, ratio: number): void {
    this.groups.setRatio(id, ratio)
    this.host.changed()
  }

  /** The divider was dragged to `at`: a place along the window's row or column, counted from the area's own start. */
  dragTo (id: string, at: number): void {
    const group = this.groups.groupOf(id)
    if (group === undefined || !Number.isFinite(at)) return
    const { width, height } = this.host.area()
    this.setRatio(id, ratioAt({ x: 0, y: 0, width, height }, group.orientation, at))
  }

  resetRatio (id: string): void {
    this.setRatio(id, 0.5)
  }

  /** Moves the pane the person is not in to the front, or false when the tab is alone. */
  focusOther (id: string): boolean {
    const partner = this.groups.partnerOf(id)
    if (partner === null) return false
    this.host.activate(partner)
    return true
  }

  /** Moves a joined pair as one, so the two stay side by side. False when the tab is not joined. */
  move (id: string, index: number): boolean {
    const group = this.groups.groupOf(id)
    if (group === undefined || !Number.isFinite(index)) return false
    const order = this.host.order
    const rest = order.filter((other) => other !== group.a && other !== group.b)
    const at = Math.min(Math.max(0, Math.trunc(index)), rest.length)
    order.splice(0, order.length, ...rest.slice(0, at), group.a, group.b, ...rest.slice(at))
    this.host.changed()
    return true
  }

  /** Makes `a` and `b` neighbours, `a` first, where the earlier of the two was. */
  private placeTogether (a: string, b: string): void {
    const order = this.host.order
    const at = Math.min(order.indexOf(a), order.indexOf(b))
    const rest = order.filter((other) => other !== a && other !== b)
    order.splice(0, order.length, ...rest.slice(0, at), a, b, ...rest.slice(at))
  }
}
