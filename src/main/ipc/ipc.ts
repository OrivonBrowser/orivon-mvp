// The shell's tab-command channel: chrome view -> main. State flows the
// other way via a direct webContents.send push (see window.ts), not IPC
// request/response, so this file is one-directional by construction.
//
// Sender check, same pattern as the senderFrame -> origin check
// build-plan.md's "Testing" section requires for the broker's T3 defense:
// every handler verifies event.senderFrame is EXACTLY the chrome view's top
// frame, by identity, AND that it is still at the chrome's own URL, before
// doing anything (`isFromChrome`). Identity keeps out every tab's page, if
// the channel were ever exposed more broadly than the chrome preload by
// accident; the URL keeps out whatever document the chrome view might be
// navigated to, independently of lock-navigation.ts refusing that. Checked
// synchronously at the top of the handler, per Electron's own warning that
// a WebFrameMain reference can go stale after an await.
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { BookmarkStore } from '../browsing/bookmarks.js'
import { COMMAND_CHANNEL } from '../channels.js'
import type { TabManager } from '../shell/tabs.js'
import type { SiteInfoController, SiteSummary } from '../permissions/site-info-controller.js'
import { web3Score } from '../browsing/site-trust.js'
import type { Web3Score } from '../browsing/site-trust.js'
import type { PanelAnchor } from '../permissions/permissions-panel.js'
import { isCommandId } from '../shortcuts/commands.js'
import type { CommandId } from '../shortcuts/commands.js'
import type { SiteInfoPage } from '../permissions/site-info-panel.js'
import { isInternalPageId } from '../pages/internal-pages.js'

export type ShellCommand =
  | { type: 'newTab'; url?: string }
  /** Runs one of the shell's commands (./../shortcuts/commands.ts) on this window: what a button does that a key also does. */
  | { type: 'runCommand'; id: string }
  /** One of the shell's own pages (Settings, History, ...), optionally at a place inside it. */
  | { type: 'openInternal'; page: string; path?: string }
  | { type: 'closeTab'; id: string }
  | { type: 'activateTab'; id: string }
  | { type: 'navigate'; id: string; input: string }
  | { type: 'back'; id: string }
  | { type: 'forward'; id: string }
  | { type: 'reload'; id: string }
  /** `tabId` is which tab is being starred, NOT an icon: main reads that
   * tab's own already-fetched favicon (TabManager.faviconFor) and stores it
   * with the bookmark. Deliberately not sent as a data: URL from the chrome
   * view -- main fetched and size-capped that value in the first place, and
   * having it round-trip through a renderer only adds a way for it to come
   * back different. */
  | { type: 'addBookmark'; url: string; title: string; tabId: string }
  | { type: 'removeBookmark'; url: string }
  | { type: 'openBookmark'; url: string }
  /** The toolbar key's own visibility and tint, from the active tab's url
   * -- whether the site has asked for anything at all, and whether any
   * asked-for row carries a warning. The full per-capability list, and the
   * every-app list, both live behind their own popovers instead (this
   * channel is chrome-only, and the chrome view itself never needs either
   * in full). */
  | { type: 'siteSummaryFor'; url: string }
  /** The address-bar shield's own signal: the active tab's displayed
   * Website level and Delivery level (`../browsing/site-trust.js`'s
   * `web3Score`), queried the same lagging, per-active-tab way
   * `siteSummaryFor` already is. `null` when there is nothing to show
   * (no loader published, no canonical origin). */
  | { type: 'web3ScoreFor'; url: string }
  /** Opens, or closes, the all-sites permissions popup under the
   * toolbar cluster's tune icon -- see ./permissions-panel.ts. `url` is
   * the active TAB's url, not yet an origin (window.ts derives one via
   * originFromUrl on the way), and says which app's card to scroll to; it
   * is absent when no tab has one.
   *
   * `anchor` is the icon's own rect, measured by the chrome view. Main
   * cannot derive it: where that button sits depends on the toolbar's CSS
   * and the window width, both of which live in the renderer. It is only a
   * position -- treated as a hint and clamped to the window in
   * panelBounds(), never trusted as a bounds to set directly. */
  | { type: 'openPermissions'; url?: string; anchor: PanelAnchor }
  /** Opens, or closes, the site-info popup under the address pill's shield
   * or key -- see ./site-info-panel.ts. Same `anchor`/`url` shape as
   * `openPermissions`; `page` is which icon was clicked (the shield opens
   * straight to the Web3 Score page, the key to the main page). */
  | { type: 'openSiteInfo'; url?: string; anchor: PanelAnchor; page: SiteInfoPage }
  /** Opens, or closes, the main menu under the toolbar's menu button. Same `anchor` contract as `openPermissions`. */
  | { type: 'openMenu'; anchor: PanelAnchor }
  /** Puts a tab at a place in the strip. */
  | { type: 'moveTab'; id: string; index: number }
  /** A genuine tab drag has started (tab-drag.ts's `begin()`, the moment the pointer passes the press
   * threshold): main starts capturing the tab's page early, so a thumbnail is usually already in hand by
   * the time (if ever) the tab actually tears out of the strip. */
  | { type: 'tabDragStart'; id: string }
  /** A tab is being dragged, below the strip, at this point of the window (`x` and `y` absent: back in the strip). */
  | { type: 'dragTab'; id: string; x?: number; y?: number }
  /** A tab was let go outside the strip: `x`, `y` where on the screen, `clientX`, `clientY` where in this window. */
  | { type: 'dropTab'; id: string; x: number; y: number; clientX: number; clientY: number }
  /** The drag ended without a tear-out: let go inside the strip, or cancelled. Releases the
   * capture `tabDragStart` began, whether or not it was ever shown as a floating preview. */
  | { type: 'endTabDrag' }
  /** The right-click menu of a tab, which main shows (it lists the other windows). */
  | { type: 'tabMenu'; id: string }
  /** A double click on the empty tail of the strip, in the manual drag mode drag-mode.ts's `dragModeFor`
   * chooses for Linux/X11 (native drag regions elsewhere handle this at the OS level, no command needed). */
  | { type: 'toggleMaximize' }
  /** The three points of a manual window move, all in screen coordinates -- the same tail, same mode. Start
   * captures where within the window the pointer took hold; `windowMoveTo` repeats on every pointer move
   * while the drag lasts; `windowMoveEnd` is where an Aero-snap-style release tiles the window, if anywhere. */
  | { type: 'windowMoveStart'; x: number; y: number }
  | { type: 'windowMoveTo'; x: number; y: number }
  | { type: 'windowMoveEnd'; x: number; y: number }
  /** The move ended in a `pointercancel`, not a release: no edge-snap action, unlike `windowMoveEnd`. */
  | { type: 'windowMoveCancel' }

/**
 * BOTH object identity AND URL, matching `newtab-ipc.ts`'s own
 * `isFromDashboard` for the second half: identity alone assumes
 * `chromeWebContents.mainFrame` can never be attached to anything but the
 * chrome document, which is exactly what `main/shell/lock-navigation.ts`'s
 * `lockNavigation` (window.ts's own call) makes true today -- but a sender
 * check that would still pass if that lock were ever removed or
 * misconfigured is the weaker of the two, not a redundant one. `chromeUrl`
 * is the same string `window.ts` passed the view at construction and the
 * preload's own gate (`preload/shell.ts`) compares `location.href` against.
 */
function isFromChrome (event: IpcMainInvokeEvent, chromeWebContents: WebContents, chromeUrl: string): boolean {
  return event.senderFrame !== null &&
    event.senderFrame === chromeWebContents.mainFrame &&
    event.senderFrame.url === chromeUrl
}

/** What the chrome's commands do that is the window's own business rather than the tab collection's. */
export interface ShellActions {
  openPermissions: (anchor: PanelAnchor, url?: string) => void
  openSiteInfo: (anchor: PanelAnchor, page: SiteInfoPage, url?: string) => void
  runCommand: (id: CommandId) => void
  openMenu: (anchor: PanelAnchor) => void
  beginTabDrag: (id: string) => void
  dragTab: (id: string, at: { x: number, y: number } | null) => void
  dropTab: (id: string, screen: { x: number, y: number }, client: { x: number, y: number }) => void
  endTabDrag: () => void
  showTabMenu: (id: string) => void
  toggleMaximize: () => void
  windowMoveStart: (point: { x: number, y: number }) => void
  windowMoveTo: (point: { x: number, y: number }) => void
  windowMoveEnd: (point: { x: number, y: number }) => void
  windowMoveCancel: () => void
}

export function registerShellIpc (
  chromeWebContents: WebContents,
  chromeUrl: string,
  tabs: TabManager,
  bookmarks: BookmarkStore,
  siteInfo: SiteInfoController,
  actions: ShellActions
): void {
  // On the chrome view's own webContents rather than the process-wide
  // ipcMain: a second window registers its own without colliding, and the
  // handler goes with the view. The frame check below stays: a webContents'
  // handlers hear every frame in it.
  chromeWebContents.ipc.handle(COMMAND_CHANNEL, (event: IpcMainInvokeEvent, command: ShellCommand): void | Promise<void | SiteSummary | Web3Score | null> => {
    if (!isFromChrome(event, chromeWebContents, chromeUrl)) {
      // Not the chrome view's top frame -- refuse silently rather than
      // throwing a message back that confirms the channel exists.
      return
    }

    switch (command.type) {
      case 'newTab':
        tabs.createTab(command.url)
        return
      case 'runCommand':
        if (isCommandId(command.id)) actions.runCommand(command.id)
        return
      case 'openInternal':
        // The page name comes from the chrome view, but is checked all the same.
        if (isInternalPageId(command.page)) tabs.openInternal(command.page, typeof command.path === 'string' ? command.path : '/')
        return
      case 'closeTab':
        tabs.closeTab(command.id)
        return
      case 'activateTab':
        tabs.activateTab(command.id)
        return
      case 'navigate':
        tabs.navigate(command.id, command.input)
        return
      case 'back':
        tabs.back(command.id)
        return
      case 'forward':
        tabs.forward(command.id)
        return
      case 'reload':
        tabs.reload(command.id)
        return
      case 'addBookmark':
        bookmarks.add({ url: command.url, title: command.title, favicon: tabs.faviconFor(command.tabId) })
        return
      case 'removeBookmark':
        bookmarks.remove(command.url)
        return
      case 'openBookmark': {
        // Open in the active tab, like typing the URL into the address
        // bar -- navigate() already runs it through the same omnibox
        // parsing, and a bookmark URL is always absolute http(s), so it
        // resolves to `kind: 'url'` unchanged, never a search fallback.
        // No active tab (the last one just closed) creates a fresh one
        // instead of silently doing nothing.
        const { activeTabId } = tabs.getState()
        if (activeTabId === null) {
          tabs.createTab(command.url)
        } else {
          tabs.navigate(activeTabId, command.url)
        }
        return
      }
      case 'siteSummaryFor':
        return siteInfo.siteSummaryFor(command.url)
      case 'web3ScoreFor':
        return siteInfo.siteTrustFor(command.url).then(web3Score)
      case 'openPermissions':
        actions.openPermissions(command.anchor, command.url)
        return
      case 'openSiteInfo':
        actions.openSiteInfo(command.anchor, command.page, command.url)
        return
      case 'openMenu':
        actions.openMenu(command.anchor)
        return
      case 'moveTab':
        if (typeof command.id === 'string' && Number.isFinite(command.index)) tabs.moveTab(command.id, command.index)
        return
      case 'tabDragStart':
        if (typeof command.id === 'string') actions.beginTabDrag(command.id)
        return
      case 'dragTab':
        if (typeof command.id === 'string') actions.dragTab(command.id, Number.isFinite(command.x) && Number.isFinite(command.y) ? { x: command.x as number, y: command.y as number } : null)
        return
      case 'dropTab':
        if (typeof command.id === 'string' && [command.x, command.y, command.clientX, command.clientY].every(Number.isFinite)) actions.dropTab(command.id, { x: command.x, y: command.y }, { x: command.clientX, y: command.clientY })
        return
      case 'endTabDrag':
        actions.endTabDrag()
        return
      case 'tabMenu':
        if (typeof command.id === 'string') actions.showTabMenu(command.id)
        return
      case 'toggleMaximize':
        actions.toggleMaximize()
        return
      case 'windowMoveStart':
        if (Number.isFinite(command.x) && Number.isFinite(command.y)) actions.windowMoveStart({ x: command.x, y: command.y })
        return
      case 'windowMoveTo':
        if (Number.isFinite(command.x) && Number.isFinite(command.y)) actions.windowMoveTo({ x: command.x, y: command.y })
        return
      case 'windowMoveEnd':
        if (Number.isFinite(command.x) && Number.isFinite(command.y)) actions.windowMoveEnd({ x: command.x, y: command.y })
        return
      case 'windowMoveCancel':
        actions.windowMoveCancel()
        return
    }
  })
}
