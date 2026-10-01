// What the chrome's buttons and menus ask of their window beyond the tab
// collection: opening one popover closes the others, and a tab can be sent to
// another window. Assembled per window from the pieces window.ts made.
import { screen } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { ShellActions } from '../ipc/ipc.js'
import { copyLinkCommand, emailLinkCommand } from '../os/share-commands.js'
import { realShareDeps } from '../os/share-runner.js'
import { shareAddressFor } from '../os/share.js'
import type { PermissionsPanel } from '../permissions/permissions-panel.js'
import type { SiteInfoPanel } from '../permissions/site-info-panel.js'
import { isRect } from './actions/overlay.js'
import { runChromeAction } from './chrome-actions.js'
import type { ShellServices } from './shell-services.js'
import { splitZoneFor } from './split-drop.js'
import { refreshStripLayouts, stripCentresFor } from './strip-centres.js'
import { dropTab, inTop, moveToNewWindow, moveToWindow } from './tab-move.js'
import { closeOthers, closeToRight, duplicateTab, newTabToRight, tabMenuFlags, toggleMute, togglePin } from './tab-commands.js'
import { sleepBackgroundTab } from '../memory-saver/sleep-command.js'
import { showTabMenu, tabMenuTemplate } from './tab-menu.js'
import { groupLabel } from '../tab-groups/group-label.js'
import { groupsFor } from '../tab-groups/groups-model.js'
import { groupTab, groupTabNew, ungroupTab } from '../tab-groups/groups-runner.js'
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
/** How long a drop waits for the strip of the window it lands in to report where its tabs are. */
const STRIP_READ_MS = 150

export interface WindowParts {
  readonly entry: ShellWindow
  readonly services: ShellServices
  /** Closes the overlay popups but not the two panels above, which a caller toggles itself. */
  readonly closeOverlays: () => void
  readonly panels: { readonly permissions: PermissionsPanel, readonly siteInfo: SiteInfoPanel }
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
  const { entry, services, panels, closeOverlays, openWindow, topHeight, area } = parts
  const { tabs, window } = entry

  /** Captured once at the start of a manual window move (drag-mode.ts), null between drags. */
  let moveGrab: DragGrab | null = null

  const showTabMenuFor = (id: string): void => {
    const { tabs: all } = tabs.getState()
    const tab = all.find((candidate) => candidate.id === id)
    const flags = tabMenuFlags({ tabs: all }, id)
    if (tab === undefined || flags === undefined) return
    const others = services.windows.all().filter((other) => other !== entry && !other.window.isDestroyed())
    // A pinned tab is never in a split, on either side of it.
    const partners = tab.pinned ? [] : all.filter((other) => other.id !== id && other.splitWith === null && !other.pinned)
    const ctx = { window: entry, services }
    showTabMenu(window, tabMenuTemplate({
      ...flags,
      grouped: (tab.group ?? null) !== null,
      groups: groupsFor(tabs).list().filter((group) => group.id !== tab.group).map((group) => ({ label: groupLabel(group), join: () => { groupTab(ctx, id, group.id) } })),
      canSleep: id !== tabs.getState().activeTabId && tab.sleeping !== true,
      tabCount: all.length,
      canShare: shareAddressFor(tab) !== undefined,
      inSplit: tab.splitWith !== null,
      splitPartners: partners.map((other) => ({ label: other.title === '' ? 'New Tab' : other.title, split: () => { tabs.splits.split(id, other.id, 'right') } })),
      otherWindows: others.map((other, position) => ({ label: windowLabel(other, position), move: () => { moveToWindow(entry, id, other) } }))
    }, {
      newTabRight: () => { newTabToRight(tabs, id) },
      reload: () => { tabs.reload(id) },
      duplicate: () => { duplicateTab(tabs, id) },
      togglePin: () => { togglePin(tabs, id) },
      toggleMute: () => { toggleMute(tabs, id) },
      newGroup: () => { groupTabNew(ctx, id) },
      ungroup: () => { ungroupTab(ctx, id) },
      sleep: () => { void sleepBackgroundTab(entry, id) },
      copyLink: () => { copyLinkCommand(entry, realShareDeps, id) },
      emailLink: () => { void emailLinkCommand(entry, realShareDeps, id) },
      moveToNewWindow: () => { moveToNewWindow(entry, id, openWindow, cascadeFrom(window.getBounds())) },
      separate: () => { tabs.splits.separate(id) },
      close: () => { tabs.closeTab(id) },
      closeOthers: () => { closeOthers(tabs, id) },
      closeRight: () => { closeToRight(tabs, id) },
      run: (command) => { services.commands.run(command, entry) }
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
      closeOverlays()
      panels.permissions.toggle(anchor, focusOrigin)
    },
    openSiteInfo: (anchor, page, url) => {
      const origin = url === undefined ? undefined : originFromUrl(url) ?? undefined
      if (origin === undefined) return // no canonical origin -- nothing this popup can show
      panels.permissions.close()
      closeOverlays()
      panels.siteInfo.toggle(anchor, origin, page)
    },
    runCommand: (id) => { services.commands.run(id, entry) },
    act: (name, payload) => runChromeAction(name, payload, { window: entry, services }),
    // The anchor comes from the chrome page: only a rectangle of numbers places a view.
    openMenu: (anchor) => { if (isRect(anchor)) entry.overlays.toggle('menu', anchor) },
    prewarmMenu: () => { entry.overlays.prewarm('menu') },
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
    // The dragged tab stays where it is in the stack: dragging a background tab onto the page in
    // front is how a split is made. A background tab's view is detached, so its capture comes back
    // empty and the floating preview shows the tab's title instead.
    beginTabDrag: (id) => { services.tearDrag.prewarm(entry, id) },
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
