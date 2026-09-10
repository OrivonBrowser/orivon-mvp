// The settings window's own command channel -- list every app's grants,
// revoke one. Mirrors ipc.ts's `isFromChrome` sender check exactly, against
// this window's own webContents instead of the chrome view's: the settings
// window's single WebContentsView never navigates anywhere else (no links,
// no address bar), so an identity check is enough, the same reasoning
// ipc.ts's own header gives for the chrome view.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { SETTINGS_COMMAND_CHANNEL } from './channels.js'
import type { AppPermissions, PermissionsController } from './permissions.js'
import type { GrantId } from '../contracts/index.js'

export type SettingsCommand =
  | { type: 'list' }
  | { type: 'revoke'; origin: string; grantId: GrantId }

function isFromSettingsWindow (event: IpcMainInvokeEvent, settingsWebContents: WebContents): boolean {
  return event.senderFrame !== null && event.senderFrame === settingsWebContents.mainFrame
}

export function registerSettingsIpc (settingsWebContents: WebContents, permissions: PermissionsController): void {
  ipcMain.handle(SETTINGS_COMMAND_CHANNEL, (event: IpcMainInvokeEvent, command: SettingsCommand): void | Promise<void | readonly AppPermissions[]> => {
    if (!isFromSettingsWindow(event, settingsWebContents)) return

    switch (command.type) {
      case 'list':
        return permissions.list()
      case 'revoke':
        return permissions.revoke(command.origin, command.grantId)
    }
  })
}
