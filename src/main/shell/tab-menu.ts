// The right-click menu of a tab: the things done to one tab rather than to the
// page in it. The template is pure and built from what the window knows;
// showing it is the caller's.
import { Menu } from 'electron'
import type { BaseWindow, MenuItemConstructorOptions } from 'electron'

export interface TabMenuModel {
  /** The new-tab page and the shell's own pages are not copied: a copy of Settings would be Settings. */
  readonly canDuplicate: boolean
  readonly tabCount: number
  /** The tab is in a split. */
  readonly inSplit: boolean
  /** The tabs it could be split with, that are not in a split already. */
  readonly splitPartners: ReadonlyArray<{ readonly label: string, readonly split: () => void }>
  /** The other windows of this process a tab can go to. */
  readonly otherWindows: ReadonlyArray<{ readonly label: string, readonly move: () => void }>
}

export interface TabMenuActions {
  reload: () => void
  duplicate: () => void
  moveToNewWindow: () => void
  separate: () => void
  close: () => void
  closeOthers: () => void
}

export function tabMenuTemplate (model: TabMenuModel, actions: TabMenuActions): MenuItemConstructorOptions[] {
  const move: MenuItemConstructorOptions[] = [
    // A window's only tab stays: moving it would only move the window.
    { label: 'Move Tab to New Window', enabled: model.tabCount > 1, click: actions.moveToNewWindow }
  ]
  if (model.otherWindows.length > 0) {
    move.push({ label: 'Move Tab to Window', submenu: model.otherWindows.map((other) => ({ label: other.label, click: other.move })) })
  }
  const split: MenuItemConstructorOptions[] = model.inSplit
    ? [{ label: 'Separate Tabs', click: actions.separate }]
    : [{ label: 'Split with', enabled: model.splitPartners.length > 0, submenu: model.splitPartners.map((partner) => ({ label: partner.label, click: partner.split })) }]
  return [
    { label: 'Reload', click: actions.reload },
    { label: 'Duplicate', enabled: model.canDuplicate, click: actions.duplicate },
    { type: 'separator' },
    ...split,
    { type: 'separator' },
    ...move,
    { type: 'separator' },
    { label: 'Close Tab', click: actions.close },
    { label: 'Close Other Tabs', enabled: model.tabCount > 1, click: actions.closeOthers }
  ]
}

export function showTabMenu (window: BaseWindow, template: MenuItemConstructorOptions[]): void {
  if (window.isDestroyed()) return
  Menu.buildFromTemplate(template).popup({ window })
}
