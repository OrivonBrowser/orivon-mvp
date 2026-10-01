// The menu a toolbar action shows on a right click: the extension's name, what
// the extension itself added, then Orivon's own entries. Native menus use
// Title Case. Pure: the template only, each entry's effect is passed in.
import type { MenuItem, MenuItemConstructorOptions } from 'electron'

export interface ActionMenuInput {
  readonly name: string
  readonly hasOptions: boolean
  readonly pinned: boolean
  /** What the extension's own `contextMenus` asked for under its action. */
  readonly extensionItems: ReadonlyArray<MenuItemConstructorOptions | MenuItem>
  readonly openOptions: () => void
  readonly togglePin: () => void
  readonly manage: () => void
  readonly remove: () => void
}

export function actionMenuTemplate (input: ActionMenuInput): Array<MenuItemConstructorOptions | MenuItem> {
  const own: MenuItemConstructorOptions[] = [
    { label: 'Options', enabled: input.hasOptions, click: input.openOptions },
    { label: input.pinned ? 'Unpin from Toolbar' : 'Pin to Toolbar', click: input.togglePin },
    { label: 'Manage Extension', click: input.manage },
    { label: 'Remove from Orivon…', click: input.remove }
  ]
  return [
    { label: input.name, enabled: false },
    { type: 'separator' },
    ...(input.extensionItems.length > 0 ? [...input.extensionItems, { type: 'separator' as const }] : []),
    ...own
  ]
}
