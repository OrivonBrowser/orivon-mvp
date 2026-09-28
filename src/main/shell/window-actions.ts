// What the chrome's buttons and menus ask of their window beyond the tab
// collection: opening one popover closes the others, and a tab can be sent to
// another window. Assembled per window from the pieces window.ts made.
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
      const zone = point === null ? null : splitZoneFor(tabs.getState().activeTabId, id, area(), point)
      tabs.splits.setPreview(zone)
    },
    dropTab: (id, screen, client) => {
      tabs.splits.setPreview(null)
      const active = tabs.getState().activeTabId
      const zone = splitZoneFor(active, id, area(), client)
      if (zone !== null && active !== null) {
        tabs.splits.split(active, id, zone)
        return
      }
      // Let go over the page but not at an edge, or over the window's own top: it stays where it was.
      const { width, height } = window.getContentBounds()
      const inWindow = client.x >= 0 && client.x < width && client.y >= 0 && client.y < height
      if (inWindow) return
      dropTab(entry, id, screen, services.windows.all(), openWindow, topHeight)
    },
    showTabMenu: showTabMenuFor
  }
}
