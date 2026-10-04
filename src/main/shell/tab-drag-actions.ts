// What the chrome's tab drag asks of its window: a preview while the tab is out of its strip, and where the tab goes
// when it is let go. Two ways to work out where, by what the platform tells a window about the screen:
// - screen positions known (X11, Windows, macOS): a floating preview window follows the cursor (tear-drag.ts) and
//   the drop is read from screen coordinates (tab-move.ts's `dropTab`);
// - not known (a native Wayland session, local-pointer.ts): the preview is a view inside the window and the drop is
//   read from positions inside the windows involved (local-tab-drag.ts, local-drop.ts).
import type { ShellActions } from '../ipc/ipc.js'
import { planLocalDrop } from './local-drop.js'
import type { Arrival } from './local-drop.js'
import { pointerIsLocal } from './local-pointer.js'
import { splitZoneFor } from './split-drop.js'
import { refreshStripLayouts, stripCentresFor } from './strip-centres.js'
import { dropTab, inTop, moveToNewWindow, moveToWindow, stripSlot } from './tab-move.js'
import type { WindowParts } from './window-actions.js'
import type { ShellWindow } from './window-registry.js'

/** How close to a page's edge a dragged tab has to be for it to split, WHILE a drag is under way -- narrower
 * than `zoneAt`'s own default share (split-model.ts), used for a plain drop, so a tab is easy to tear off
 * rather than getting caught by a wide edge band on the way to open space. */
const TAB_DRAG_SPLIT_SHARE = 0.12
/** How long a drop waits for the strip of the window it lands in to report where its tabs are. */
const STRIP_READ_MS = 150

export type TabDragActions = Pick<ShellActions, 'beginTabDrag' | 'dragTab' | 'dropTab' | 'endTabDrag' | 'tabDragArrived'>

export function tabDragActions (parts: WindowParts): TabDragActions {
  const { entry, services, openWindow, topHeight, area } = parts
  const { tabs, window } = entry
  const local = (): boolean => pointerIsLocal()

  const splitZone = (id: string, point: { x: number, y: number }) => splitZoneFor(tabs.getState().activeTabId, id, area(), point, TAB_DRAG_SPLIT_SHARE)

  /** A tab let go where screen positions are unknown. Whatever is decided from this window alone is done at once;
   * a drop that may be over another window's strip waits for that window to say the pointer arrived there. */
  const dropWhereLocal = (id: string, client: { x: number, y: number }): void => {
    const { localDrag } = services
    const decide = (arrival: Arrival<ShellWindow> | null) => planLocalDrop({
      client,
      content: window.getContentBounds(),
      topHeight,
      zone: splitZone(id, client),
      arrival,
      slotOf: (target, x) => stripSlot(target, () => x, x / Math.max(1, target.window.getContentBounds().width), tabs.record(id)?.pinned === true)
    })
    const now = decide(null)
    const active = tabs.getState().activeTabId
    if (now.kind === 'split' && active !== null) {
      localDrag.finish()
      tabs.splits.split(active, id, now.zone)
      return
    }
    void localDrag.settle().then(async (arrival) => {
      const live = arrival !== null && !arrival.window.window.isDestroyed() ? arrival : null
      if (live !== null && stripCentresFor(live.window) === null) await refreshStripLayouts([live.window], STRIP_READ_MS)
      localDrag.finish()
      if (window.isDestroyed()) return
      const plan = decide(live)
      if (plan.kind === 'move') moveToWindow(entry, id, plan.window, plan.index)
      else if (plan.kind === 'window') {
        // The compositor places a new window; a position asked for here would only be echoed back unchanged.
        const own = window.getBounds()
        moveToNewWindow(entry, id, openWindow, { width: own.width, height: own.height })
      }
    })
  }

  /** A tab let go where screen positions are known. */
  const dropWhereGlobal = (id: string, screenPoint: { x: number, y: number }): void => {
    // Not a split: over another window's strip, moves there; over this window's own top rows (strip and
    // toolbar), stays where it was, matching the floating preview parking there instead of following the
    // pointer (tear-drag.ts's own tick()); anywhere else -- this window's own page, or outside every
    // window -- opens a window of its own, the floating preview's own promise. `dropTab` (tab-move.ts)
    // decides which, from `screenPoint` alone. A strip whose layout was not read yet (a drop with no
    // hover over it) is read first: the slot is the one under the pointer, not a share of the width.
    const windows = services.windows.all()
    const unread = windows.filter((other) => other !== entry && !other.window.isDestroyed() && inTop(other.window.getBounds(), screenPoint, topHeight) && stripCentresFor(other) === null)
    if (unread.length === 0) {
      dropTab(entry, id, screenPoint, windows, openWindow, topHeight)
      return
    }
    void refreshStripLayouts(unread, STRIP_READ_MS).then(() => {
      if (!window.isDestroyed()) dropTab(entry, id, screenPoint, services.windows.all(), openWindow, topHeight)
    })
  }

  return {
    // The dragged tab stays where it is in the stack: dragging a background tab onto the page in
    // front is how a split is made. A background tab's view is detached, so its capture comes back
    // empty and the preview shows the tab's title instead.
    beginTabDrag: (id) => {
      if (local()) services.localDrag.begin(entry, id)
      else services.tearDrag.prewarm(entry, id)
    },
    dragTab: (id, point) => {
      const zone = point === null ? null : splitZone(id, point)
      tabs.splits.setPreview(zone)
      // point === null: the pointer is back inside the strip, which happens on every in-strip
      // pointermove of a drag that has not (or not yet) torn out -- never a reason to tear down the
      // preview or throw away the capture `beginTabDrag` started; `endTabDrag` is the only thing that
      // does that, once the drag genuinely ends. The floating preview's own poll hides it when the real
      // cursor is back over this window's strip; the preview inside the window is hidden here.
      if (local()) {
        if (point === null) services.localDrag.hide()
        else services.localDrag.update(entry, id, point, zone !== null, topHeight)
      } else if (point !== null) {
        services.tearDrag.update(entry, id, zone !== null, topHeight)
      }
    },
    endTabDrag: () => {
      if (local()) services.localDrag.ended()
      else services.tearDrag.clear()
    },
    dropTab: (id, screenPoint, client) => {
      tabs.splits.setPreview(null)
      if (local()) {
        dropWhereLocal(id, client)
        return
      }
      services.tearDrag.clear()
      const active = tabs.getState().activeTabId
      const zone = splitZone(id, client)
      if (zone !== null && active !== null) {
        tabs.splits.split(active, id, zone)
        return
      }
      dropWhereGlobal(id, screenPoint)
    },
    // The first position another window's chrome saw the pointer at, while a tab is dragged from a window.
    tabDragArrived: (point) => { services.localDrag.arrived(entry, point) }
  }
}
