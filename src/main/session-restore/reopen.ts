// Brings back what was closed last: a tab where it was, or a whole window.
import type { CommandDeps } from '../shortcuts/run-command.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { ClosedEntry, ClosedStack } from './closed-stack.js'
import { optionsFor } from './restore.js'
import { openSnapshot } from './open-snapshot.js'
import { rejoinGroup } from '../tab-groups/groups-runner.js'

/** `full`: the window has no room for another tab, and the entry stays. `unusable`: it could not be opened, and is dropped. */
export type ReopenResult = 'opened' | 'unusable' | 'full'

function windowOfEntry (entry: ClosedEntry & { kind: 'tab' }, target: ShellWindow, deps: CommandDeps): ShellWindow {
  const home = deps.services.windows.all().find((candidate) => !candidate.window.isDestroyed() && candidate.window.id === entry.windowKey)
  return home ?? target
}

/**
 * Reopens one entry of the closed stack and takes it off. A tab returns to the window it was closed in when
 * that is still open, else to `target`, at the place it had. A window returns with its size, place and tabs.
 */
export function reopenEntry (entry: ClosedEntry, target: ShellWindow, deps: CommandDeps): ReopenResult {
  const stack = deps.services.closedTabs
  if (entry.kind === 'window') {
    stack.take(entry.id)
    deps.openWindow(optionsFor(entry.window, deps.displays()))
    return 'opened'
  }
  const home = windowOfEntry(entry, target, deps)
  if (!home.tabs.hasRoom()) return 'full'
  stack.take(entry.id)
  const id = openSnapshot(home.tabs, entry.tab, true)
  if (id === undefined) return 'unusable'
  home.tabs.moveTab(id, Math.min(entry.index, home.tabs.tabCount - 1))
  if (entry.groupId !== undefined) rejoinGroup(home.tabs, id, entry.groupId)
  home.tabs.changed()
  // The person pressed the key in another window than the one the tab returned to: bring that one forward.
  if (home !== target) { home.window.show(); home.window.focus() }
  return 'opened'
}

/** The key: reopens the newest entry that can be opened. Nothing happens when there is none. */
export function reopenClosed (target: ShellWindow, deps: CommandDeps): void {
  const stack = deps.services.closedTabs
  for (let entry = stack.peek(); entry !== undefined; entry = stack.peek()) {
    if (reopenEntry(entry, target, deps) !== 'unusable') return
  }
}

/** The page's title, else where it is from: a bare address is not a name. */
function labelOf (tab: { title: string, url: string }): string {
  return (tab.title.length > 0 ? tab.title : hostOf(tab.url)).replace(/\s+/g, ' ').trim()
}

function hostOf (url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** What the menu shows beside "Reopen closed tab": the title of what would come back, or how many tabs. */
export function hintFor (stack: ClosedStack): string | null {
  const next = stack.peek()
  if (next === undefined) return null
  if (next.kind === 'tab') return labelOf(next.tab)
  const { tabs } = next.window
  const only = tabs[0]
  return tabs.length === 1 && only !== undefined ? labelOf(only) : `${String(tabs.length)} tabs`
}
