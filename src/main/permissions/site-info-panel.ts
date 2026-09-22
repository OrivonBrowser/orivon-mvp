// The site-info popup: what the shield and key toolbar icons open. Shares
// its `WebContentsView` lifecycle with ./permissions-panel.ts through
// ./popover-view.js; this file owns the site-info content on top of it.
//
// LEFT-ALIGNED, unlike the all-sites panel: both toolbar icons that open
// this sit near the LEFT edge of the address pill, so a right-aligned
// popup would hang off the window's own left edge instead of the icon.

import { ipcMain, type BaseWindow, type View, type WebContents } from 'electron'
import { SITE_INFO_COMMAND_CHANNEL } from '../channels.js'
import type { SiteInfoController } from './site-info-controller.js'
import { registerSiteInfoIpc } from '../ipc/site-info-ipc.js'
import { createPopoverView } from './popover-view.js'
import type { PopoverAnchor } from './popover-view.js'

/** Which page the popup opens showing -- the connection row's own switches
 * (`'main'`) or the delivery-evidence page a shield click or the main
 * page's own Web3 Score row leads to (`'web3'`). The Cookies and site data
 * page is reached only from within the popup once open, never as an entry
 * point, so it has no argv flag of its own. */
export type SiteInfoPage = 'main' | 'web3'

export interface SiteInfoPanel {
  /** Clicking either toolbar icon again while the popup is open closes it,
   * the same `toggle` shape ./permissions-panel.ts already has. Opening it
   * on a DIFFERENT origin never happens through this alone: window.ts
   * closes this popup on every active-tab and active-origin change first
   * (`../shell/window.ts`), so a toggle call always either opens fresh or
   * closes what is already showing the origin it was opened for. */
  toggle: (anchor: PopoverAnchor, origin: string, page: SiteInfoPage) => void
  close: () => void
  isOpen: () => boolean
}

export function createSiteInfoPanel (
  win: BaseWindow,
  contentView: View,
  controller: SiteInfoController,
  userDataPath: string,
  activeWebContents: () => WebContents | undefined,
  reloadActiveTab: () => void,
  openAllSites: () => void,
  dirname: string
): SiteInfoPanel {
  // Read by the IPC registration closure below, set on every open BEFORE
  // the popup's own webContents is created -- so the very first command
  // it can possibly send already has the right origin to act on. Never
  // read from anything the popup's own page sends (this file's own header).
  let openOrigin = ''

  const popover = createPopoverView(win, contentView, {
    dirname,
    entryPath: '/site-info/',
    fallbackHtml: '../renderer/site-info/index.html',
    preloadRelPath: '../preload/site-info.js',
    urlArgName: 'orivon-site-info-url',
    align: 'left',
    registerIpc: (webContents, onContentHeight) => {
      registerSiteInfoIpc(webContents, controller, openOrigin, userDataPath, activeWebContents, reloadActiveTab, openAllSites, onContentHeight)
      return () => { ipcMain.removeHandler(SITE_INFO_COMMAND_CHANNEL) }
    }
  })

  return {
    toggle (anchor, origin, page) {
      openOrigin = origin
      popover.toggle(anchor, [`--orivon-site-info-page=${page}`, `--orivon-site-info-origin=${origin}`])
    },
    close: popover.close,
    isOpen: popover.isOpen
  }
}
