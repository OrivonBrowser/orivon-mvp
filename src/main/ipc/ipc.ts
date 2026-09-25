// The shell's tab-command channel: chrome view -> main. State flows the
// other way via a direct webContents.send push (see window.ts), not IPC
// request/response, so this file is one-directional by construction.
//
// Sender check, same pattern as the senderFrame -> origin check
// build-plan.md's "Testing" section requires for the broker's T3 defense:
// every handler verifies event.senderFrame is
// EXACTLY the chrome view's top frame before doing anything. Without this,
// any web page loaded in a tab could reach this channel too, if it were
// ever exposed more broadly than the chrome preload by accident -- object
// identity against a known frame is a stronger guard than a URL allowlist,
// and it costs nothing here since main already holds the one true
// reference. Checked synchronously at the top of the handler, per
// Electron's own warning that a WebFrameMain reference can go stale after
// an await.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { BookmarkStore } from '../browsing/bookmarks.js'
import { COMMAND_CHANNEL } from '../channels.js'
import type { TabManager } from '../shell/tabs.js'
import type { SiteInfoController, SiteSummary } from '../permissions/site-info-controller.js'
import type { DeliveryProvenance } from '../browsing/delivery-provenance.js'
import type { PanelAnchor } from '../permissions/permissions-panel.js'
import type { SiteInfoPage } from '../permissions/site-info-panel.js'

export type ShellCommand =
  | { type: 'newTab'; url?: string }
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
  /** S4-6, ADR-0007: whether the active tab's URL is currently being
   * answered from Orivon's own pinned local cache -- the address-bar
   * shield's one truthful provenance signal, queried the same lagging,
   * per-active-tab way `siteSummaryFor` already is (see
   * ./delivery-provenance.ts). */
  | { type: 'deliveryProvenanceFor'; url: string }
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
  | { type: 'openSettings'; url?: string; anchor: PanelAnchor }
  /** Opens, or closes, the site-info popup under the address pill's shield
   * or key -- see ./site-info-panel.ts. Same `anchor`/`url` shape as
   * `openSettings`; `page` is which icon was clicked (the shield opens
   * straight to the Web3 Score page, the key to the main page). */
  | { type: 'openSiteInfo'; url?: string; anchor: PanelAnchor; page: SiteInfoPage }

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

export function registerShellIpc (
  chromeWebContents: WebContents,
  chromeUrl: string,
  tabs: TabManager,
  bookmarks: BookmarkStore,
  siteInfo: SiteInfoController,
  openSettings: (anchor: PanelAnchor, url?: string) => void,
  openSiteInfo: (anchor: PanelAnchor, page: SiteInfoPage, url?: string) => void,
  /** Injected, matching `siteInfo` above -- ipc.test.ts stubs this rather
   * than reaching through to a real Electron `session`, the same reason
   * `siteInfo` is a `SiteInfoController` object rather than an imported
   * broker call. Defaults to `deliveryProvenanceFor` in window.ts's real
   * construction. */
  deliveryProvenance: (url: string) => Promise<DeliveryProvenance> = async () => ({ servedFromPinnedCache: false })
): void {
  ipcMain.handle(COMMAND_CHANNEL, (event: IpcMainInvokeEvent, command: ShellCommand): void | Promise<void | SiteSummary | DeliveryProvenance | null> => {
    if (!isFromChrome(event, chromeWebContents, chromeUrl)) {
      // Not the chrome view's top frame -- refuse silently rather than
      // throwing a message back that confirms the channel exists.
      return
    }

    switch (command.type) {
      case 'newTab':
        tabs.createTab(command.url)
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
      case 'deliveryProvenanceFor':
        return deliveryProvenance(command.url)
      case 'openSettings':
        openSettings(command.anchor, command.url)
        return
      case 'openSiteInfo':
        openSiteInfo(command.anchor, command.page, command.url)
        return
    }
  })
}
