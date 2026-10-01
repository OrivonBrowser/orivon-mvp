// The right-click menu of a tab: the things done to one tab rather than to the
// page in it. The template is pure and built from what the window knows;
// showing it is the caller's.
import { Menu } from 'electron'
import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import type { CommandId } from '../shortcuts/commands.js'

export interface TabMenuModel {
  /** The new-tab page and the shell's own pages are not copied: a copy of Settings would be Settings. */
  readonly canDuplicate: boolean
  readonly pinned: boolean
  readonly muted: boolean
  /** The tab is behind the one the person is in and is awake. Absent reads as false. */
  readonly canSleep?: boolean
  /** A tab in a split is not pinned: the pair stays side by side. */
  readonly canPin: boolean
  /** There is an unpinned tab besides this one to close. */
  readonly othersClosable: boolean
  /** There is an unpinned tab to the right of this one to close. */
  readonly rightClosable: boolean
  readonly tabCount: number
  /** The tab is in a split. */
  readonly inSplit: boolean
  /** The tabs it could be split with, that are not in a split already. */
  readonly splitPartners: ReadonlyArray<{ readonly label: string, readonly split: () => void }>
  /** The other windows of this process a tab can go to. */
  readonly otherWindows: ReadonlyArray<{ readonly label: string, readonly move: () => void }>
}

export interface TabMenuActions {
  newTabRight: () => void
  reload: () => void
  duplicate: () => void
  togglePin: () => void
  toggleMute: () => void
  sleep: () => void
  moveToNewWindow: () => void
  separate: () => void
  close: () => void
  closeOthers: () => void
  closeRight: () => void
  /** Runs a command on the window, for an entry that belongs to another feature (Reopen Closed Tab). */
  run: (id: CommandId) => void
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
    { label: 'New Tab to the Right', click: actions.newTabRight },
    { type: 'separator' },
    { label: 'Reload', click: actions.reload },
    { label: 'Duplicate', enabled: model.canDuplicate, click: actions.duplicate },
    { label: model.pinned ? 'Unpin Tab' : 'Pin Tab', enabled: model.pinned || model.canPin, click: actions.togglePin },
    { label: model.muted ? 'Unmute Tab' : 'Mute Tab', click: actions.toggleMute },
    { label: 'Put Tab to Sleep', enabled: model.canSleep === true, click: actions.sleep },
    { type: 'separator' },
    ...split,
    { type: 'separator' },
    ...move,
    { type: 'separator' },
    { label: 'Close Tab', click: actions.close },
    { label: 'Close Other Tabs', enabled: model.othersClosable, click: actions.closeOthers },
    { label: 'Close Tabs to the Right', enabled: model.rightClosable, click: actions.closeRight },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', click: () => { actions.run('tab.reopen') } }
  ]
}

export function showTabMenu (window: BaseWindow, template: MenuItemConstructorOptions[]): void {
  if (window.isDestroyed()) return
  Menu.buildFromTemplate(template).popup({ window })
}
