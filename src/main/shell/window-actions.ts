// What the chrome's buttons and menus ask of their window beyond the tab
// collection: opening one popover closes the others, and a tab can be sent to
// another window. Assembled per window from the pieces window.ts made.
import { screen } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { ShellActions } from '../ipc/ipc.js'
import type { PermissionsPanel } from '../permissions/permissions-panel.js'
import type { PopoverAnchor } from '../permissions/popover-view.js'
import type { SiteInfoPanel } from '../permissions/site-info-panel.js'
import type { MenuPanel } from './menu-panel.js'
import type { ShellServices } from './shell-services.js'
import { splitZoneFor } from './split-drop.js'
import { dropTab, moveToNewWindow, moveToWindow } from './tab-move.js'
import { showTabMenu, tabMenuTemplate } from './tab-menu.js'
import { cascadeFrom } from './window-options.js'
import type { ShellWindowOptions } from './window-options.js'
import type { Bounds } from './tab-types.js'
import type { ShellWindow } from './window-registry.js'
import { edgeZoneFor, grabFor, halfOfWorkArea, positionFor, restorePositionFor } from './window-move.js'
import type { DragGrab } from './window-move.js'

/** How close to a page's edge a dragged tab has to be for it to split, WHILE a drag is under way -- narrower
 * than `zoneAt`'s own default share (split-model.ts), used for a plain drop, so a tab is easy to tear off
 * rather than getting caught by a wide edge band on the way to open space. */
const TAB_DRAG_SPLIT_SHARE = 0.12

/** What the site-info popover last opened on, so its "Site settings" row can open the all-sites list beside it. */
export interface SiteInfoMemory {
  anchor: PopoverAnchor | null
  origin: string | undefined
}

export interface WindowParts {
  readonly entry: ShellWindow
  readonly services: ShellServices
  readonly panels: { readonly permissions: PermissionsPanel, readonly siteInfo: SiteInfoPanel, readonly menu: MenuPanel }
  readonly memory: SiteInfoMemory
  readonly openWindow: (options: ShellWindowOptions) => void
  /** How tall the top of the window (tab strip and toolbar) is: where another window's strip can be dropped on. */
  readonly topHeight: number
  /** The area the tabs' pages share, in window coordinates. */
  readonly area: () => Bounds
}

function windowLabel (other: ShellWindow, position: number): string {
  const { tabs, activeTabId } = other.tabs.getState()
  const title = tabs.find((tab) => tab.id === activeTabId)?.title ?? ''
  return `Window ${String(position + 1)}: ${title === '' ? 'New Tab' : title}`
}

export function shellActions (parts: WindowParts): ShellActions {
  const { entry, services, panels, memory, openWindow, topHeight, area } = parts
  const { tabs, window } = entry

  /** Captured once at the start of a manual window move (drag-mode.ts), null between drags. */
  let moveGrab: DragGrab | null = null

  const showTabMenuFor = (id: string): void => {
    const { tabs: all } = tabs.getState()
    const tab = all.find((candidate) => candidate.id === id)
    if (tab === undefined) return
    const others = services.windows.all().filter((other) => other !== entry && !other.window.isDestroyed())
    showTabMenu(window, tabMenuTemplate({
      canDuplicate: !tab.isInternal,
      tabCount: all.length,
      inSplit: tab.splitWith !== null,
      splitPartners: all.filter((other) => other.id !== id && other.splitWith === null).map((other) => ({ label: other.title === '' ? 'New Tab' : other.title, split: () => { tabs.splits.split(id, other.id, 'right') } })),
      otherWindows: others.map((other, position) => ({ label: windowLabel(other, position), move: () => { moveToWindow(entry, id, other) } }))
    }, {
      reload: () => { tabs.reload(id) },
      duplicate: () => { tabs.createTab(tab.isNewTab ? undefined : tab.url) },
      moveToNewWindow: () => { moveToNewWindow(entry, id, openWindow, cascadeFrom(window.getBounds())) },
      separate: () => { tabs.splits.separate(id) },
      close: () => { tabs.closeTab(id) },
      closeOthers: () => { for (const other of all) if (other.id !== id) tabs.closeTab(other.id) }
    }))
  }

  return {
    openPermissions: (anchor, url) => {
      // The chrome view sends the active TAB's url, not an origin -- same
      // `originFromUrl` tab-view.ts's own appTabArgsFor already uses for
      // the identical derivation. undefined (no tab, or the dashboard) and
      // an unparseable url both mean "no particular app to scroll to", not
      // an error.
      const focusOrigin = url === undefined ? undefined : originFromUrl(url) ?? undefined
      panels.siteInfo.close() // only one popup open at a time
      panels.menu.close()
      panels.permissions.toggle(anchor, focusOrigin)
    },
    openSiteInfo: (anchor, page, url) => {
      const origin = url === undefined ? undefined : originFromUrl(url) ?? undefined
      if (origin === undefined) return // no canonical origin -- nothing this popup can show
      memory.anchor = anchor
      memory.origin = origin
      panels.permissions.close()
      panels.menu.close()
      panels.siteInfo.toggle(anchor, origin, page)
    },
    runCommand: (id) => { services.commands.run(id, entry) },
    openMenu: (anchor) => {
      panels.permissions.close()
      panels.siteInfo.close()
      panels.menu.toggle(anchor)
    },
    dragTab: (id, point) => {
      const zone = point === null ? null : splitZoneFor(tabs.getState().activeTabId, id, area(), point, TAB_DRAG_SPLIT_SHARE)
      tabs.splits.setPreview(zone)
      // point === null: the pointer is back inside the strip, which happens on every in-strip
      // pointermove of a drag that has not (or not yet) torn out -- never a reason to tear down the
      // floating preview or throw away the capture `beginTabDrag` started; `endTabDrag` is the only
      // thing that does that, once the drag genuinely ends. tick()'s own poll already hides the
      // preview when the real cursor is back over this window's own strip.
      if (point !== null) services.tearDrag.update(entry, id, zone !== null, topHeight)
    },
    beginTabDrag: (id) => {
      // Matches other browsers: dragging a background tab brings it to the front. It also means
      // its view is attached again, so the capture beginTabDrag's own prewarm takes is not of an
      // empty, detached page.
      tabs.activateTab(id)
      services.tearDrag.prewarm(entry, id)
    },
    endTabDrag: () => { services.tearDrag.clear() },
    dropTab: (id, screenPoint, client) => {
      tabs.splits.setPreview(null)
      services.tearDrag.clear()
      const active = tabs.getState().activeTabId
      const zone = splitZoneFor(active, id, area(), client, TAB_DRAG_SPLIT_SHARE)
      if (zone !== null && active !== null) {
        tabs.splits.split(active, id, zone)
        return
      }
      // Not a split: over another window's strip, moves there; over this window's own top rows (strip and
      // toolbar), stays where it was, matching the floating preview parking there instead of following the
      // pointer (tear-drag.ts's own tick()); anywhere else -- this window's own page, or outside every
      // window -- opens a window of its own, the floating preview's own promise. `dropTab` (tab-move.ts)
      // decides which, from `screenPoint` alone.
      dropTab(entry, id, screenPoint, services.windows.all(), openWindow, topHeight)
    },
    showTabMenu: showTabMenuFor,
    toggleMaximize: () => { if (window.isMaximized()) window.unmaximize(); else window.maximize() },
    windowMoveStart: (point) => { moveGrab = grabFor(point, window.getBounds()) },
    windowMoveTo: (point) => {
      if (moveGrab === null) return
      if (window.isMaximized()) {
        // getBounds() read right after unmaximize() still reports the maximized size on X11 (the
        // request is asynchronous) -- getNormalBounds(), read before asking to unmaximize, is what
        // the restored width, and the grab this recomputes for the moves after it, actually need.
        const restored = window.getNormalBounds()
        window.unmaximize()
        const to = restorePositionFor(point, restored.width, moveGrab)
        window.setPosition(to.x, to.y)
        moveGrab = grabFor(point, { ...restored, x: to.x, y: to.y })
      } else {
        const to = positionFor(point, moveGrab)
        window.setPosition(to.x, to.y)
      }
    },
    windowMoveEnd: (point) => {
      moveGrab = null
      const workArea = screen.getDisplayNearestPoint(point).workArea
      const zone = edgeZoneFor(point, workArea)
      if (zone === 'maximize') window.maximize()
      else if (zone !== null) window.setBounds(halfOfWorkArea(workArea, zone))
    },
    // A pointercancel's own coordinates are not where the pointer actually was: just stop tracking
    // the move, with no edge-snap action (unlike windowMoveEnd).
    windowMoveCancel: () => { moveGrab = null }
  }
}
