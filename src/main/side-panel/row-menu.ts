// The right-click menu of a row, as a native menu template. Pure: what each item does is handed in. Native menus
// are Title Case.
import type { MenuItemConstructorOptions } from 'electron'

export interface RowMenuActions {
  openInTab: () => void
  openInWindow: () => void
  copyLink: () => void
  /** Absent for a view that deletes nothing. */
  remove?: (() => void) | undefined
}

export function rowMenuTemplate (actions: RowMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: 'Open in New Tab', click: actions.openInTab },
    { label: 'Open in New Window', click: actions.openInWindow },
    { type: 'separator' },
    { label: 'Copy Link', click: actions.copyLink },
    ...(actions.remove === undefined ? [] : [{ label: 'Delete', click: actions.remove }])
  ]
}
