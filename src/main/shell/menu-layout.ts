// What the main menu lists, and in what order. The labels and keys are the
// shortcut registry's, so the menu can never show a key that does not work or
// a name that differs from the Settings page's.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { CommandId } from '../shortcuts/commands.js'
import { commandById } from '../shortcuts/commands.js'
import { bookmarksBarShown } from './bookmarks-bar/bar-visibility.js'
import { qrAvailable } from '../qr/qr-open.js'
import { hintFor } from '../session-restore/reopen.js'
import { sidePanelFor } from '../side-panel/side-panel-host.js'
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

/** Commands that do nothing on some pages; the menu greys their row there. */
const UNAVAILABLE: Partial<Record<CommandId, (ctx: WindowContext) => boolean>> = {
  'page.qr': ({ window }) => !qrAvailable(window),
  'tab.ungroup': ({ window }) => {
    const { tabs, activeTabId } = window.tabs.getState()
    return (tabs.find((tab) => tab.id === activeTabId)?.group ?? null) === null
  }
}

export const MENU_LAYOUT: readonly MenuEntry[] = [
  'tab.new',
  'window.new',
  'window.newPrivate',
  '-',
  'history.open',
  { item: 'tab.reopen', hint: ({ services }) => hintFor(services.closedTabs) },
  'downloads.open',
  'bookmark.toggle',
  { submenu: 'Bookmarks', items: [
    'bookmark.allTabs',
    'readingList.add',
    '-',
    { check: 'bookmarks.toggleBar', on: ({ services }) => bookmarksBarShown(services) },
    'bookmarks.open',
    'readingList.open',
    '-',
    'import.open'
  ] },
  '-',
  { zoom: true },
  '-',
  'page.print',
  'find.open',
  'page.save',
  { submenu: 'Share', items: ['share.copyLink', 'share.email'] },
  { submenu: 'More tools', items: [
    'split.toggle',
    'tab.search',
    'tab.group',
    'tab.ungroup',
    'page.screenshot',
    'page.pip',
    'page.pdf',
    'page.qr',
    'page.viewSource',
    'site.shortcut',
    { check: 'window.alwaysOnTop', on: ({ window }) => window.window.isAlwaysOnTop() },
    'page.reader',
    { check: 'sidePanel.toggle', on: ({ window }) => sidePanelFor(window).isOpen() },
    { check: 'caret.toggle', on: ({ services }) => services.settings.get('accessibility.caretBrowsing') },
    'tab.sleep',
    'privacy.clearData',
    'devtools.toggle',
    'devtools.console',
    'tasks.open'
  ] },
  '-',
  'extensions.open',
  'passwords.open',
  'profiles.open',
  'settings.open',
  '-',
  'about.open',
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
    /** Present (true) when the page in front gives the command nothing to do: the row is shown greyed and does not run. */
    readonly disabled?: true
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
  // `hint` and `checked` are read only for a command that is offered: a reserved one has nothing to run yet, and
  // what it would ask of the window may not exist either.
  const command = (id: CommandId, hint: () => string | null, checked: () => boolean | null): MenuItemView[] => {
    const row = rows.get(id)
    if (row === undefined || commandById(id)?.pending === true) return []
    const disabled = UNAVAILABLE[id]?.(ctx) === true
    return [{ kind: 'command', id, label: commandById(id)?.label ?? row.label, keys: row.keys, hint: hint(), checked: checked(), ...(disabled ? { disabled: true as const } : {}) }]
  }
  const build = (entries: readonly MenuEntry[]): MenuItemView[] => tidy(entries.flatMap((entry): MenuItemView[] => {
    if (entry === '-') return [{ kind: 'separator' }]
    if (typeof entry === 'string') return command(entry, () => null, () => null)
    if ('zoom' in entry) return [zoomRow(ctx)]
    if ('check' in entry) return command(entry.check, () => null, () => entry.on(ctx))
    if ('item' in entry) return command(entry.item, () => entry.hint(ctx), () => null)
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
      if (item.kind === 'command') { if (item.disabled !== true) ids.add(item.id) }
      else if (item.kind === 'submenu') visit(item.items)
      else if (item.kind === 'zoom') {
        for (const id of ZOOM_ROW_COMMANDS) if (item.zoomable || id === 'window.fullscreen') ids.add(id)
      }
    }
  }
  visit(items)
  return ids
}
