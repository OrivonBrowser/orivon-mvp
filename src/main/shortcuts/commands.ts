// Every command a keyboard shortcut can run, with its default binding. The
// key handling, the macOS menu and the Shortcuts section all read this one
// table, so a command exists in all three or none. A command is added here in
// the change that gives it something to run, or as a reserved row whose case in
// run-command.ts does nothing until its feature lands.

/** `tools` is the Page tools group: find, print, save, source, screenshot. */
export type CommandCategory = 'tabs' | 'navigation' | 'tools' | 'window'

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
  /** In a registered app's tab the key goes to the app, not to the browser: the app has its own find, print or save. */
  readonly yieldToApp?: boolean
  /** A reserved row: the command does nothing yet, so its chord stays with the page. The feature's change deletes this flag with the stub case in run-command.ts. */
  readonly pending?: true
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
  { id: 'tab.moveLeft', label: 'Move tab left', category: 'tabs', default: 'Mod+Shift+PageUp', repeatable: true },
  { id: 'tab.moveRight', label: 'Move tab right', category: 'tabs', default: 'Mod+Shift+PageDown', repeatable: true },
  { id: 'split.toggle', label: 'Split view', category: 'tabs', default: 'Mod+Alt+S' },
  { id: 'split.focusOther', label: 'Go to the other pane', category: 'tabs', default: 'Mod+Alt+O' },
  { id: 'split.swap', label: 'Swap the panes', category: 'tabs', default: 'Mod+Alt+X' },
  { id: 'split.rotate', label: 'Side by side or stacked', category: 'tabs' },
  { id: 'tab.moveToNewWindow', label: 'Move tab to a new window', category: 'tabs' },
  { id: 'tab.reopen', label: 'Reopen closed tab', category: 'tabs', default: 'Mod+Shift+T' },
  { id: 'tab.duplicate', label: 'Duplicate tab', category: 'tabs' },
  { id: 'tab.pin', label: 'Pin tab', category: 'tabs' },
  { id: 'tab.mute', label: 'Mute tab', category: 'tabs' },
  { id: 'tab.closeOthers', label: 'Close other tabs', category: 'tabs' },
  { id: 'tab.closeRight', label: 'Close tabs to the right', category: 'tabs' },
  { id: 'tab.group', label: 'Add tab to new group', category: 'tabs' },
  { id: 'tab.ungroup', label: 'Remove tab from group', category: 'tabs' },
  { id: 'tab.sleep', label: 'Put tab to sleep', category: 'tabs' },
  { id: 'tab.search', label: 'Search tabs', category: 'tabs', default: 'Mod+Shift+A' },
  ...GO_TO_TAB,
  { id: 'tab.gotoLast', label: 'Go to the last tab', category: 'tabs', default: 'Mod+9' },
  { id: 'nav.back', label: 'Back', category: 'navigation', default: 'Alt+Left', macDefault: 'Mod+[' },
  { id: 'nav.forward', label: 'Forward', category: 'navigation', default: 'Alt+Right', macDefault: 'Mod+]' },
  { id: 'nav.reload', label: 'Reload', category: 'navigation', default: 'Mod+R', aliases: ['F5'] },
  { id: 'nav.hardReload', label: 'Reload without the cache', category: 'navigation', default: 'Mod+Shift+R', aliases: ['Ctrl+F5'] },
  { id: 'nav.stop', label: 'Stop loading', category: 'navigation' },
  { id: 'nav.home', label: 'Home page', category: 'navigation', default: 'Alt+Home', macDefault: 'Mod+Shift+H' },
  { id: 'nav.focusAddress', label: 'Go to the address bar', category: 'navigation', default: 'Mod+L', aliases: ['Alt+D'] },
  // F6 is the next-pane key; the address bar keeps Mod+L and Alt+D.
  { id: 'focus.nextPane', label: 'Next pane', category: 'navigation', default: 'F6' },
  { id: 'focus.previousPane', label: 'Previous pane', category: 'navigation', default: 'Shift+F6' },
  { id: 'focus.toolbar', label: 'Go to the toolbar', category: 'navigation', default: 'Alt+Shift+T' },
  { id: 'nav.focusSearch', label: 'Search the web', category: 'navigation', default: 'Mod+K', aliases: ['Mod+E'], yieldToApp: true },
  { id: 'zoom.in', label: 'Zoom in', category: 'navigation', default: 'Mod+=', aliases: ['Mod++'], repeatable: true },
  { id: 'zoom.out', label: 'Zoom out', category: 'navigation', default: 'Mod+-', repeatable: true },
  { id: 'zoom.reset', label: 'Actual size', category: 'navigation', default: 'Mod+0' },
  { id: 'history.open', label: 'History', category: 'navigation', default: 'Mod+H' },
  { id: 'privacy.clearData', label: 'Clear browsing data', category: 'navigation', default: 'Mod+Shift+Delete', pending: true },
  { id: 'downloads.open', label: 'Downloads', category: 'navigation', default: 'Mod+J', yieldToApp: true },
  { id: 'devtools.toggle', label: 'Developer tools', category: 'navigation', default: 'F12', macDefault: 'Mod+Alt+I', aliases: ['Mod+Shift+I'] },
  { id: 'devtools.console', label: 'JavaScript console', category: 'navigation', default: 'Mod+Shift+J', macDefault: 'Mod+Alt+J' },
  { id: 'bookmark.toggle', label: 'Bookmark this page', category: 'navigation', default: 'Mod+D' },
  { id: 'bookmark.allTabs', label: 'Bookmark all tabs', category: 'navigation', default: 'Mod+Shift+D', pending: true },
  { id: 'bookmarks.open', label: 'Bookmark manager', category: 'navigation', default: 'Mod+Shift+O', pending: true },
  { id: 'bookmarks.toggleBar', label: 'Show bookmarks bar', category: 'navigation', default: 'Mod+Shift+B' },
  { id: 'readingList.add', label: 'Add page to reading list', category: 'navigation', pending: true },
  { id: 'readingList.open', label: 'Reading list', category: 'navigation', pending: true },
  { id: 'find.open', label: 'Find in page', category: 'tools', default: 'Mod+F', yieldToApp: true },
  { id: 'find.next', label: 'Find next', category: 'tools', default: 'Mod+G', aliases: ['F3'], repeatable: true, yieldToApp: true },
  { id: 'find.previous', label: 'Find previous', category: 'tools', default: 'Mod+Shift+G', aliases: ['Shift+F3'], repeatable: true, yieldToApp: true },
  { id: 'page.print', label: 'Print', category: 'tools', default: 'Mod+P', yieldToApp: true },
  { id: 'page.pdf', label: 'Save as PDF', category: 'tools' },
  { id: 'page.save', label: 'Save page as', category: 'tools', default: 'Mod+S', yieldToApp: true },
  { id: 'page.viewSource', label: 'View page source', category: 'tools', default: 'Mod+U', yieldToApp: true },
  { id: 'page.reader', label: 'Reader view', category: 'tools', default: 'F9' },
  { id: 'page.forceDark', label: 'Dark mode for this site', category: 'tools', pending: true },
  { id: 'caret.toggle', label: 'Caret browsing', category: 'tools', default: 'F7', yieldToApp: true },
  { id: 'share.copyLink', label: 'Copy link', category: 'tools', pending: true },
  { id: 'share.email', label: 'Email link', category: 'tools', pending: true },
  { id: 'site.certificate', label: 'View certificate', category: 'tools', pending: true },
  { id: 'site.shortcut', label: 'Create shortcut', category: 'tools', pending: true },
  { id: 'page.screenshot', label: 'Take a screenshot', category: 'tools', default: 'Mod+Shift+S', yieldToApp: true },
  { id: 'page.qr', label: 'Create QR code for this page', category: 'tools' },
  { id: 'page.pip', label: 'Picture in picture', category: 'tools' },
  { id: 'window.new', label: 'New window', category: 'window', default: 'Mod+N' },
  { id: 'window.newPrivate', label: 'New private window', category: 'window', default: 'Mod+Shift+N' },
  { id: 'window.newGuest', label: 'New guest window', category: 'window', pending: true },
  { id: 'profiles.open', label: 'Profiles', category: 'window' },
  { id: 'window.close', label: 'Close window', category: 'window', default: 'Mod+Shift+W' },
  { id: 'window.fullscreen', label: 'Full screen', category: 'window', default: 'F11', macDefault: 'Ctrl+Meta+F' },
  { id: 'window.alwaysOnTop', label: 'Keep window on top', category: 'window' },
  { id: 'sidePanel.toggle', label: 'Side panel', category: 'window', default: 'Mod+Alt+B' },
  { id: 'settings.open', label: 'Open Settings', category: 'window', default: 'Mod+,' },
  { id: 'passwords.open', label: 'Passwords', category: 'window', pending: true },
  { id: 'siteSettings.open', label: 'Site settings', category: 'window', pending: true },
  { id: 'extensions.open', label: 'Extensions', category: 'window' },
  { id: 'import.open', label: 'Import bookmarks and history', category: 'window', pending: true },
  { id: 'about.open', label: 'About Orivon', category: 'window' },
  // Shift+Escape is an alias, not the default: a binding needs Ctrl, Alt or Cmd, and this one is fixed to match the key other browsers use.
  { id: 'tasks.open', label: 'Task manager', category: 'window', aliases: ['Shift+Escape'] },
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
