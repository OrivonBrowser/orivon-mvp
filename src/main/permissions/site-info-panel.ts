// The site-info popup: what the shield, key and tunnel toolbar icons open. Shares
// its `WebContentsView` lifecycle with ../networks/networks-panel.ts through
// ./popover-view.js; this file owns the site-info content on top of it.
//
// LEFT-ALIGNED, unlike the Available networks popup: the shield and the key sit
// near the LEFT edge of the address pill, so a right-aligned popup would hang off
// the window's own left edge instead of the icon. The tunnel button at the right
// end is placed by the same clamping to the window (`popover-view.ts`).

import type { BaseWindow, View, WebContents } from 'electron'
import type { SiteInfoController } from './site-info-controller.js'
import { registerSiteInfoIpc } from '../ipc/site-info-ipc.js'
import { registerSiteInfoTabIpc } from '../ipc/site-info-tab-ipc.js'
import { popupIsAbout } from './popover-arrival.js'
import { createPopoverView } from './popover-view.js'
import type { PopoverAnchor } from './popover-view.js'
import { PANEL_POPOVER_BACKGROUND } from '../shell/theme-colors.js'
import type { SitePermissionsAccess } from '../site-settings/site-permissions-view.js'
import type { FirstPage } from '../shell/window-state.js'

/** Which page the popup opens showing -- the connection row's own switches
 * (`'main'`) or the delivery-evidence page a shield click or the main
 * page's own Web3 Score row leads to (`'web3'`), or the list of tunnels the tunnel button
 * opens (`'tunnels'`). The Cookies and site data
 * page is reached only from within the popup once open, never as an entry
 * point, so it has no argv flag of its own. */
export type SiteInfoPage = 'main' | 'web3' | 'tunnels'

export interface SiteInfoPanel {
  /** Clicking the icon that opened the popup again closes it, the same
   * `toggle` shape ../networks/networks-panel.ts already has; clicking the other
   * icon while it shows swaps it to that icon's page. Opening it on a
   * DIFFERENT origin never happens through this alone: window.ts closes
   * this popup on every active-tab and active-origin change first
   * (`../shell/window.ts`), so a toggle call always either opens fresh or
   * closes what is already showing the origin it was opened for. */
  toggle: (anchor: PopoverAnchor, origin: string, page: SiteInfoPage, pressedAt?: number) => void
  /** The tunnels page for the tab `tabId` rather than for a website: the tab is fixed for the popup's life, as an origin is. The tunnel button of a new tab, and of every website in a tab, opens it. */
  toggleTab: (anchor: PopoverAnchor, tabId: string, pressedAt?: number) => void
  close: () => void
  /** Closes the popup unless it is about what `arrived` names: the first page its tab committed, or the tab. A list the tunnel button opened while a tab's page was loading is still right when the page comes; any other change of origin leaves it stale. */
  closeUnlessAbout: (arrived: FirstPage | null) => void
  /** The popup was just opened while `contents`, a tab's page, had not committed: the page taking the keyboard as it commits does not close it (`PopoverView.holdAgainstArrival`). */
  holdAgainstArrival: (contents: WebContents) => void
  isOpen: () => boolean
  restack: () => void
}

export function createSiteInfoPanel (
  win: BaseWindow,
  contentView: View,
  controller: SiteInfoController,
  userDataPath: string,
  activeWebContents: () => WebContents | undefined,
  reloadActiveTab: () => void,
  openSettings: (path?: string) => void,
  openExtensions: () => void,
  openCertificate: () => void,
  sitePermissions: SitePermissionsAccess,
  openHome: (domain: string) => void,
  openScoreHelp: () => void,
  openSupport: (url: string) => void,
  dirname: string
): SiteInfoPanel {
  // Read by the IPC registration closure below, set on every open BEFORE
  // the popup's own webContents is created -- so the very first command
  // it can possibly send already has the right origin to act on. Never
  // read from anything the popup's own page sends (this file's own header).
  let openOrigin = ''
  /** Set instead of `openOrigin` on an open for a tab; the same rule applies to it. */
  let openTab: string | null = null
  /** The website the popup of `openTab` was drawn for, '' for none. */
  let openShown = ''

  const popover = createPopoverView(win, contentView, {
    dirname,
    entryPath: '/site-info/',
    entry: 'site-info',
    preloadRelPath: '../preload/site-info.js',
    urlArgName: 'orivon-site-info-url',
    align: 'left',
    background: PANEL_POPOVER_BACKGROUND,
    activeContents: activeWebContents,
    registerIpc: (webContents, url, onContentHeight) => {
      if (openTab !== null) {
        registerSiteInfoTabIpc(webContents, url, controller, openTab, openSettings, onContentHeight, () => { popover.close() })
        return () => {}
      }
      registerSiteInfoIpc(webContents, url, controller, openOrigin, userDataPath, activeWebContents, reloadActiveTab, openSettings, openExtensions, onContentHeight, openCertificate, sitePermissions, () => { popover.close() }, openHome, openScoreHelp, openSupport)
      return () => {}
    }
  })

  return {
    toggle (anchor, origin, page, pressedAt) {
      openOrigin = origin
      openTab = null
      openShown = ''
      popover.toggle(anchor, [`--orivon-site-info-page=${page}`, `--orivon-site-info-origin=${origin}`], page, pressedAt)
    },
    toggleTab (anchor, tabId, pressedAt) {
      openTab = tabId
      openShown = controller.tabShownOrigin(tabId)
      popover.toggle(anchor, ['--orivon-site-info-page=tunnels'], 'tunnels', pressedAt)
    },
    close: popover.close,
    closeUnlessAbout (arrived) {
      if (!popover.isOpen() || !popupIsAbout({ tab: openTab, origin: openOrigin, shown: openShown }, arrived)) popover.close()
    },
    holdAgainstArrival: popover.holdAgainstArrival,
    isOpen: popover.isOpen,
    restack: popover.restack
  }
}
