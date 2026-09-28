import { contextBridge, ipcRenderer } from 'electron'
import { MENU_COMMAND_CHANNEL } from '../main/channels.js'
import type { MenuItemView } from '../main/shell/menu-layout.js'

// Loaded ONLY by the main menu popover's own view (src/main/shell/menu-panel.ts).
// The same defence as the other popovers' preloads: nothing is exposed unless
// the document is at the address main gave it. src/main/ipc/menu-ipc.ts
// re-verifies the sender on every call and only runs what the menu lists.
const URL_PREFIX = '--orivon-menu-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  contextBridge.exposeInMainWorld('orivonMenu', {
    items: async (): Promise<readonly MenuItemView[]> => {
      const result: unknown = await ipcRenderer.invoke(MENU_COMMAND_CHANNEL, { type: 'items' })
      return Array.isArray(result) ? result as MenuItemView[] : []
    },
    run: (id: string): void => { void ipcRenderer.invoke(MENU_COMMAND_CHANNEL, { type: 'run', id }) },
    /** Tells main how tall the list is, so the popover sizes to it. */
    reportHeight: (height: number): void => { void ipcRenderer.invoke(MENU_COMMAND_CHANNEL, { type: 'contentHeight', height }) }
  })
}
