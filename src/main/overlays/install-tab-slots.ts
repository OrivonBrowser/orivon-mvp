// Tells the tab slots when a tab comes to the front or goes away. The slots
// themselves need no other wiring: a feature's overlay forwards its `closed`
// to `slotClosed`.
import type { ShellInstaller } from '../shell/shell-installers.js'
import { sheetBackdrop } from '../shell/sheet-backdrop.js'
import { setSheetBackdrop, tabSlotEvents } from './tab-slots.js'

export const installTabSlots: ShellInstaller = {
  name: 'tab-slots',
  install: (_app, services) => {
    setSheetBackdrop(sheetBackdrop)
    services.tabLifecycle.subscribe({
      tabActivated: (contents) => {
        const found = services.windows.findTab(contents)
        if (found !== null) tabSlotEvents.tabActivated(found.window, found.tabId)
      },
      tabClosing: ({ id, window }) => {
        const owner = services.windows.all().find((candidate) => candidate.window === window)
        if (owner !== undefined) tabSlotEvents.tabClosed(owner, id)
      }
    })
  }
}
