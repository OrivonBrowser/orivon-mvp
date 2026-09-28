// The main menu popover's own channel: what it lists, and which command the
// person chose. The popover is a page in a view of its own, so this checks the
// sender the way the other popovers' channels do; the command it asks to run
// must be one the menu lists, not any the registry has.
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { MENU_COMMAND_CHANNEL } from '../channels.js'
import type { MenuItemView } from '../shell/menu-layout.js'
import { isCommandId } from '../shortcuts/commands.js'
import type { CommandId } from '../shortcuts/commands.js'

export type MenuCommand =
  | { type: 'items' }
  | { type: 'run', id: string }
  | { type: 'contentHeight', height: number }

export interface MenuHost {
  items: () => MenuItemView[]
  /** Runs `id` on the window the menu belongs to, and closes the menu. */
  run: (id: CommandId) => void
}

function isFromMenu (event: IpcMainInvokeEvent, menuContents: WebContents): boolean {
  return event.senderFrame !== null && event.senderFrame === menuContents.mainFrame
}

export function registerMenuIpc (menuContents: WebContents, host: MenuHost, onContentHeight: (height: number) => void): void {
  menuContents.ipc.handle(MENU_COMMAND_CHANNEL, (event: IpcMainInvokeEvent, command: MenuCommand): MenuItemView[] | undefined => {
    if (!isFromMenu(event, menuContents)) return undefined
    switch (command.type) {
      case 'items':
        return host.items()
      case 'run': {
        const listed = host.items().some((item) => item.kind === 'command' && item.id === command.id)
        if (isCommandId(command.id) && listed) host.run(command.id)
        return undefined
      }
      case 'contentHeight':
        if (Number.isFinite(command.height)) onContentHeight(command.height)
        return undefined
    }
  })
}
