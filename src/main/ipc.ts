// The shell's tab-command channel: chrome view -> main. State flows the
// other way via a direct webContents.send push (see window.ts), not IPC
// request/response, so this file is one-directional by construction.
//
// Sender check (this session's plan, rule 2; same pattern as the
// senderFrame -> origin check build-plan.md SS Testing requires for the
// broker's T3 defense): every handler verifies event.senderFrame is
// EXACTLY the chrome view's top frame before doing anything. Without this,
// any web page loaded in a tab could reach this channel too, if it were
// ever exposed more broadly than the chrome preload by accident -- object
// identity against a known frame is a stronger guard than a URL allowlist,
// and it costs nothing here since main already holds the one true
// reference. Checked synchronously at the top of the handler, per
// Electron's own warning that a WebFrameMain reference can go stale after
// an await.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { TabManager } from './tabs.js'

export type ShellCommand =
  | { type: 'newTab'; url?: string }
  | { type: 'closeTab'; id: string }
  | { type: 'activateTab'; id: string }
  | { type: 'navigate'; id: string; input: string }
  | { type: 'back'; id: string }
  | { type: 'forward'; id: string }
  | { type: 'reload'; id: string }

const CHANNEL = 'orivon-shell:command'

function isFromChrome (event: IpcMainInvokeEvent, chromeWebContents: WebContents): boolean {
  return event.senderFrame !== null &&
    event.senderFrame === chromeWebContents.mainFrame
}

export function registerShellIpc (chromeWebContents: WebContents, tabs: TabManager): void {
  ipcMain.handle(CHANNEL, (event: IpcMainInvokeEvent, command: ShellCommand) => {
    if (!isFromChrome(event, chromeWebContents)) {
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
    }
  })
}
