// What the chrome's tab drag asks of its window, in one of two ways, by what the platform tells a window about the screen:
// - screen positions known (X11, Windows, macOS): the chrome drags with pointer capture, a floating preview window
//   follows the cursor (tear-drag.ts) and the drop is read from screen coordinates (tab-move.ts's `dropTab`);
// - not known (a native Wayland session, local-pointer.ts): the browser's own drag and drop carries the tab, and
//   native-tab-drag.ts holds the drag while this file says what each outcome does to the window.
import type { ShellActions } from '../ipc/ipc.js'
import { splitZoneFor } from './split-drop.js'
import { refreshStripLayouts, stripCentresFor } from './strip-centres.js'
import type { NativeDragOps } from './native-tab-drag.js'
import type { NativeOutcome } from './native-drag-plan.js'
import { dropTab, inTop, moveToNewWindow, moveToWindow } from './tab-move.js'
import type { WindowParts } from './window-actions.js'
import type { ShellWindow } from './window-registry.js'

/** How close to a page's edge a dragged tab has to be for it to split, WHILE a drag is under way -- narrower
 * than `zoneAt`'s own default share (split-model.ts), used for a plain drop, so a tab is easy to tear off
 * rather than getting caught by a wide edge band on the way to open space. */
const TAB_DRAG_SPLIT_SHARE = 0.12
/** How long a drop waits for the strip of the window it lands in to report where its tabs are. */
const STRIP_READ_MS = 150

export type TabDragActions = Pick<ShellActions, 'beginTabDrag' | 'dragTab' | 'dropTab' | 'endTabDrag' | 'prepareTabDrag' | 'warmDropCatchers' | 'reachChrome' | 'startNativeTabDrag' | 'dropNativeTab' | 'endNativeTabDrag' | 'cancelNativeTabDrag'>

export function tabDragActions (parts: WindowParts): TabDragActions {
  const { entry, services, openWindow, topHeight, area, reachChrome } = parts
  const { tabs, window } = entry

  const splitZone = (id: string, point: { x: number, y: number }) => splitZoneFor(tabs.getState().activeTabId, id, area(), point, TAB_DRAG_SPLIT_SHARE)

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

  /** What a native drag's outcome does to the window it began in. */
  const applyNative = (id: string, outcome: NativeOutcome<ShellWindow>): void => {
    switch (outcome.kind) {
      case 'none':
        return
      case 'reorder':
        tabs.moveTab(id, outcome.index)
        return
      case 'move':
        moveToWindow(entry, id, outcome.window, outcome.index)
        return
      case 'split': {
        const active = tabs.getState().activeTabId
        if (active !== null) tabs.splits.split(active, id, outcome.zone)
        return
      }
      case 'window': {
        // The compositor places a new window; a position asked for here would only be echoed back unchanged.
        const own = window.getBounds()
        moveToNewWindow(entry, id, openWindow, { width: own.width, height: own.height })
      }
    }
  }

  return {
    // The dragged tab stays where it is in the stack: dragging a background tab onto the page in
    // front is how a split is made. A background tab's view is detached, so its capture comes back
    // empty and the preview shows the tab's title instead.
    beginTabDrag: (id) => { services.tearDrag.prewarm(entry, id) },
    dragTab: (id, point) => {
      const zone = point === null ? null : splitZone(id, point)
      tabs.splits.setPreview(zone)
      // point === null: the pointer is back inside the strip, which happens on every in-strip
      // pointermove of a drag that has not (or not yet) torn out -- never a reason to tear down the
      // preview or throw away the capture `beginTabDrag` started; `endTabDrag` is the only thing that
      // does that, once the drag genuinely ends. The floating preview's own poll hides it when the real
      // cursor is back over this window's strip.
      if (point !== null) services.tearDrag.update(entry, id, zone !== null, topHeight)
    },
    endTabDrag: () => { services.tearDrag.clear() },
    dropTab: (id, screenPoint, client) => {
      tabs.splits.setPreview(null)
      services.tearDrag.clear()
      const active = tabs.getState().activeTabId
      const zone = splitZone(id, client)
      if (zone !== null && active !== null) {
        tabs.splits.split(active, id, zone)
        return
      }
      dropWhereGlobal(id, screenPoint)
    },
    prepareTabDrag: async (id) => tabs.record(id) === undefined ? null : await services.nativeDrag.thumbnail(entry, id),
    warmDropCatchers: () => { services.nativeDrag.warm() },
    reachChrome,
    startNativeTabDrag: (id, nonce) => {
      if (tabs.record(id) === undefined) return
      const ops: NativeDragOps = {
        pinned: tabs.record(id)?.pinned === true,
        splitZone: (point) => splitZone(id, point),
        setSplitPreview: (zone) => { tabs.splits.setPreview(zone) },
        apply: (outcome) => { applyNative(id, outcome) }
      }
      services.nativeDrag.start(entry, nonce, ops)
    },
    dropNativeTab: (nonce, index, below) => { services.nativeDrag.dropped(entry, nonce, index, below) },
    endNativeTabDrag: (nonce) => { services.nativeDrag.ended(entry, nonce) },
    cancelNativeTabDrag: (nonce) => { services.nativeDrag.cancelled(entry, nonce) }
  }
}
