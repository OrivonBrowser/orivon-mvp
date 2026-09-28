// What the main menu lists, and in what order. The labels and keys are the
// shortcut registry's, so the menu can never show a key that does not work or
// a name that differs from the Settings page's.
import type { CommandId } from '../shortcuts/commands.js'
import { commandById } from '../shortcuts/commands.js'
import type { ShortcutService } from '../shortcuts/shortcut-service.js'

/** A command, or `-` for a separator. A feature adds its entry when it lands. */
export const MENU_LAYOUT: readonly (CommandId | '-')[] = [
  'tab.new',
  'window.new',
  '-',
  'bookmark.toggle',
  '-',
  'zoom.in',
  'zoom.out',
  'zoom.reset',
  '-',
  'devtools.toggle',
  '-',
  'settings.open',
  '-',
  'app.quit'
]

export type MenuItemView =
  | { readonly kind: 'separator' }
  | { readonly kind: 'command', readonly id: CommandId, readonly label: string, readonly keys: readonly string[] | null }

export function menuItems (service: ShortcutService): MenuItemView[] {
  const rows = new Map(service.rows().map((row) => [row.id, row]))
  return MENU_LAYOUT.flatMap((entry): MenuItemView[] => {
    if (entry === '-') return [{ kind: 'separator' }]
    const row = rows.get(entry)
    return row === undefined ? [] : [{ kind: 'command', id: entry, label: commandById(entry)?.label ?? row.label, keys: row.keys }]
  })
}
