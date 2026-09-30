// What the main menu lists, and in what order. The labels and keys are the
// shortcut registry's, so the menu can never show a key that does not work or
// a name that differs from the Settings page's.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { CommandId } from '../shortcuts/commands.js'
import { commandById } from '../shortcuts/commands.js'
import type { WindowContext } from './window-context.js'

/** One line of the layout. A feature adds its entry beside the entries it belongs with. */
export type MenuEntry = '-' | CommandId
  /** Zoom out, the level (which resets it), zoom in, and full screen. */
  | { readonly zoom: true }
  /** A command with a tick: `on` says whether it is in effect now. */
  | { readonly check: CommandId, readonly on: (ctx: WindowContext) => boolean }
  /** A command with a short dim note after its label, in place of its keys. */
  | { readonly item: CommandId, readonly hint: (ctx: WindowContext) => string | null }
  /** A row that opens `items` in place of the menu, under a row that goes back. */
  | { readonly submenu: string, readonly items: readonly MenuEntry[] }

export const MENU_LAYOUT: readonly MenuEntry[] = [
  'tab.new',
  'window.new',
  'window.newPrivate',
  '-',
  'history.open',
  'bookmark.toggle',
  '-',
  { zoom: true },
  '-',
  'page.print',
  'page.save',
  { submenu: 'More tools', items: [
    'split.toggle',
    'page.screenshot',
    'page.pip',
    'page.pdf',
    'page.viewSource',
    { check: 'window.alwaysOnTop', on: ({ window }) => window.window.isAlwaysOnTop() },
    'devtools.toggle'
  ] },
  '-',
  'extensions.open',
  'profiles.open',
  'settings.open',
  '-',
  'app.quit'
]

export type MenuItemView =
  | { readonly kind: 'separator' }
  | {
    readonly kind: 'command'
    readonly id: CommandId
    readonly label: string
    readonly keys: readonly string[] | null
    readonly hint: string | null
    /** Null for an entry that is not a tick; otherwise whether it is on. */
    readonly checked: boolean | null
  }
  /** `zoomable` is false on a page that has no zoom of its own (the new-tab page, a shell page). */
  | { readonly kind: 'zoom', readonly percent: number, readonly zoomable: boolean }
  | { readonly kind: 'submenu', readonly label: string, readonly items: readonly MenuItemView[] }

/** The commands the zoom row runs. */
export const ZOOM_ROW_COMMANDS: readonly CommandId[] = ['zoom.out', 'zoom.reset', 'zoom.in', 'window.fullscreen']

function zoomRow (ctx: WindowContext): MenuItemView {
  const { tabs: order, activeTabId } = ctx.window.tabs.getState()
  const url = order.find((tab) => tab.id === activeTabId)?.url
  const origin = url === undefined ? null : originFromUrl(url)
  return { kind: 'zoom', percent: ctx.services.zoom.percentFor(origin), zoomable: origin !== null }
}

/** Drops separators that start, end or double up, so an entry that vanished leaves no gap. */
function tidy (items: readonly MenuItemView[]): MenuItemView[] {
  const kept: MenuItemView[] = []
  for (const item of items) {
    if (item.kind === 'separator' && (kept.length === 0 || kept.at(-1)?.kind === 'separator')) continue
    kept.push(item)
  }
  if (kept.at(-1)?.kind === 'separator') kept.pop()
  return kept
}

export function menuItems (ctx: WindowContext, layout: readonly MenuEntry[] = MENU_LAYOUT): MenuItemView[] {
  const rows = new Map(ctx.services.shortcuts.rows().map((row) => [row.id, row]))
  const command = (id: CommandId, hint: string | null, checked: boolean | null): MenuItemView[] => {
    const row = rows.get(id)
    return row === undefined ? [] : [{ kind: 'command', id, label: commandById(id)?.label ?? row.label, keys: row.keys, hint, checked }]
  }
  const build = (entries: readonly MenuEntry[]): MenuItemView[] => tidy(entries.flatMap((entry): MenuItemView[] => {
    if (entry === '-') return [{ kind: 'separator' }]
    if (typeof entry === 'string') return command(entry, null, null)
    if ('zoom' in entry) return [zoomRow(ctx)]
    if ('check' in entry) return command(entry.check, null, entry.on(ctx))
    if ('item' in entry) return command(entry.item, entry.hint(ctx), null)
    const items = build(entry.items)
    return items.length === 0 ? [] : [{ kind: 'submenu', label: entry.submenu, items }]
  }))
  return build(layout)
}

/** Every command the menu lists, at any depth, that a request may run now. */
export function runnableIds (items: readonly MenuItemView[]): ReadonlySet<CommandId> {
  const ids = new Set<CommandId>()
  const visit = (list: readonly MenuItemView[]): void => {
    for (const item of list) {
      if (item.kind === 'command') ids.add(item.id)
      else if (item.kind === 'submenu') visit(item.items)
      else if (item.kind === 'zoom') {
        for (const id of ZOOM_ROW_COMMANDS) if (item.zoomable || id === 'window.fullscreen') ids.add(id)
      }
    }
  }
  visit(items)
  return ids
}
