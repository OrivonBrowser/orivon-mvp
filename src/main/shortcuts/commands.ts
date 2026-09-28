// Every command a keyboard shortcut can run, with its default binding. The
// key handling, the macOS menu and the Shortcuts section all read this one
// table, so a command exists in all three or none. A command is added here in
// the change that gives it something to run.

export type CommandCategory = 'tabs' | 'navigation' | 'window'

export interface CommandDef {
  readonly id: string
  readonly label: string
  readonly category: CommandCategory
  /** Written as `Mod+Shift+T`; absent means unbound until the person binds it. */
  readonly default?: string
  /** Used instead of `default` on macOS. */
  readonly macDefault?: string
  /** Fixed extra bindings that stay whatever the person rebinds the command to. */
  readonly aliases?: readonly string[]
  /** Runs again while the key is held down. */
  readonly repeatable?: boolean
}

const GO_TO_TAB = [1, 2, 3, 4, 5, 6, 7, 8].map((n): CommandDef => ({
  id: `tab.goto${String(n)}`,
  label: `Go to tab ${String(n)}`,
  category: 'tabs',
  default: `Mod+${String(n)}`
}))

export const COMMANDS = [
  { id: 'tab.new', label: 'New tab', category: 'tabs', default: 'Mod+T' },
  { id: 'tab.close', label: 'Close tab', category: 'tabs', default: 'Mod+W', aliases: ['Ctrl+F4'] },
  { id: 'tab.next', label: 'Next tab', category: 'tabs', default: 'Ctrl+Tab', aliases: ['Ctrl+PageDown'], repeatable: true },
  { id: 'tab.previous', label: 'Previous tab', category: 'tabs', default: 'Ctrl+Shift+Tab', aliases: ['Ctrl+PageUp'], repeatable: true },
  ...GO_TO_TAB,
  { id: 'tab.gotoLast', label: 'Go to the last tab', category: 'tabs', default: 'Mod+9' },
  { id: 'nav.back', label: 'Back', category: 'navigation', default: 'Alt+Left', macDefault: 'Mod+[' },
  { id: 'nav.forward', label: 'Forward', category: 'navigation', default: 'Alt+Right', macDefault: 'Mod+]' },
  { id: 'nav.reload', label: 'Reload', category: 'navigation', default: 'Mod+R', aliases: ['F5'] },
  { id: 'nav.hardReload', label: 'Reload without the cache', category: 'navigation', default: 'Mod+Shift+R', aliases: ['Ctrl+F5'] },
  { id: 'nav.focusAddress', label: 'Go to the address bar', category: 'navigation', default: 'Mod+L', aliases: ['F6', 'Alt+D'] },
  { id: 'zoom.in', label: 'Zoom in', category: 'navigation', default: 'Mod+=', aliases: ['Mod++'], repeatable: true },
  { id: 'zoom.out', label: 'Zoom out', category: 'navigation', default: 'Mod+-', repeatable: true },
  { id: 'zoom.reset', label: 'Actual size', category: 'navigation', default: 'Mod+0' },
  { id: 'devtools.toggle', label: 'Developer tools', category: 'navigation', default: 'F12', macDefault: 'Mod+Alt+I', aliases: ['Mod+Shift+I'] },
  { id: 'bookmark.toggle', label: 'Bookmark this page', category: 'navigation', default: 'Mod+D' },
  { id: 'window.new', label: 'New window', category: 'window', default: 'Mod+N' },
  { id: 'window.close', label: 'Close window', category: 'window', default: 'Mod+Shift+W' },
  { id: 'window.fullscreen', label: 'Full screen', category: 'window', default: 'F11', macDefault: 'Ctrl+Meta+F' },
  { id: 'settings.open', label: 'Open Settings', category: 'window', default: 'Mod+,' },
  { id: 'app.quit', label: 'Quit Orivon', category: 'window', default: 'Ctrl+Shift+Q' }
] as const satisfies readonly CommandDef[]

export type CommandId = (typeof COMMANDS)[number]['id']

const BY_ID: ReadonlyMap<string, CommandDef> = new Map(COMMANDS.map((command) => [command.id, command]))

export function commandById (id: string): CommandDef | undefined {
  return BY_ID.get(id)
}

export function isCommandId (id: unknown): id is CommandId {
  return typeof id === 'string' && BY_ID.has(id)
}
