// Queue item 4.4's permissions surface, as an in-window panel hanging off
// the toolbar cluster's tune icon -- owner, 2026-09-16, replacing the
// separate BaseWindow this used to open. A browser does not send you to
// another window to see what a site may do, and neither should this.
//
// The `WebContentsView` lifecycle (sizing, click-away dismissal, content-
// height resizing) lives in ./popover-view.js, shared with the site-info
// popover (./site-info-panel.js); this file owns only the grant-list
// content on top of it.

import type { BaseWindow, View } from 'electron'
import type { PermissionsController, SiteNotificationsController } from './permissions.js'
import { registerPermissionsIpc } from '../ipc/permissions-ipc.js'
import { createPopoverView } from './popover-view.js'
import { onVerifierChange, verifierView } from '../verifier/verifier-subsystem.js'
import type { PopoverAnchor } from './popover-view.js'
import { PANEL_POPOVER_BACKGROUND } from '../shell/theme-colors.js'

export type { PopoverAnchor as PanelAnchor } from './popover-view.js'

export interface PermissionsPanel {
  /** Clicking the tune icon again while the panel is open closes it, the
   * way every browser's own toolbar popup behaves. */
  toggle: (anchor: PopoverAnchor, focusOrigin: string | undefined) => void
  close: () => void
  isOpen: () => boolean
}

export function createPermissionsPanel (
  win: BaseWindow,
  contentView: View,
  permissions: PermissionsController,
  dirname: string,
  sites: SiteNotificationsController
): PermissionsPanel {
  const popover = createPopoverView(win, contentView, {
    dirname,
    entryPath: '/permissions/',
    fallbackHtml: '../renderer/permissions/index.html',
    preloadRelPath: '../preload/permissions.js',
    urlArgName: 'orivon-permissions-url',
    align: 'right',
    background: PANEL_POPOVER_BACKGROUND,
    registerIpc: (webContents, url, onContentHeight) => {
      return registerPermissionsIpc(webContents, url, permissions, onContentHeight, sites, { view: verifierView, subscribe: onVerifierChange })
    }
  })

  return {
    toggle (anchor, focusOrigin) {
      popover.toggle(anchor, focusOrigin !== undefined ? [`--orivon-focus-origin=${focusOrigin}`] : [])
    },
    close: popover.close,
    isOpen: popover.isOpen
  }
}
