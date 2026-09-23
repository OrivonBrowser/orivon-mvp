// Queue item 4.4's permissions surface, as an in-window panel hanging off
// the toolbar cluster's tune icon -- owner, 2026-09-16, replacing the
// separate BaseWindow this used to open. A browser does not send you to
// another window to see what a site may do, and neither should this.
//
// The `WebContentsView` lifecycle (sizing, click-away dismissal, content-
// height resizing) lives in ./popover-view.js, shared with the site-info
// popover (./site-info-panel.js); this file owns only the grant-list
// content on top of it.

import { ipcMain, type BaseWindow, type View } from 'electron'
import { SETTINGS_COMMAND_CHANNEL } from '../channels.js'
import type { PermissionsController, SiteNotificationsController } from './permissions.js'
import { registerSettingsIpc } from '../ipc/settings-ipc.js'
import { createPopoverView } from './popover-view.js'
import type { PopoverAnchor } from './popover-view.js'

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
    entryPath: '/settings/',
    fallbackHtml: '../renderer/settings/index.html',
    preloadRelPath: '../preload/settings.js',
    urlArgName: 'orivon-settings-url',
    align: 'right',
    registerIpc: (webContents, onContentHeight) => {
      registerSettingsIpc(webContents, permissions, onContentHeight, sites)
      return () => { ipcMain.removeHandler(SETTINGS_COMMAND_CHANNEL) }
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
