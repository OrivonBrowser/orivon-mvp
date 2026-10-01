// The registry a feature adds a field of the chrome's state through: one
// ShellStatePart per feature, listed in SHELL_STATE_PARTS. The field itself is
// one line in `ShellState` (tab-types.ts). window-state.ts reads every part on
// each push and starts every part's watcher with the window.
import { contain } from './contain.js'
import { bookmarkedStatePart } from './bookmarks-bar/bar-state.js'
import { contentBlockedStatePart } from './state/content-blocked.js'
import { addressBarStatePart } from './state/address-bar.js'
import { groupsStatePart } from './state/groups.js'
import { downloadsStatePart } from './state/downloads.js'
import { extensionsStatePart } from './state/extensions.js'
import { homeStatePart } from './state/home.js'
import { loginsStatePart } from '../passwords/logins-state.js'
import { popupsBlockedStatePart } from './state/popups-blocked.js'
import { shortcutsStatePart } from './state/shortcuts.js'
import { sidePanelStatePart } from './state/side-panel.js'
import { siteAccessStatePart } from './state/site-access.js'
import type { ShellState, TabsSnapshot } from './tab-types.js'
import type { WindowContext } from './window-context.js'

export interface ShellStatePart {
  readonly name: string
  /** What this part adds to one push. Runs on every push, so it reads memory, never a disk. */
  read: (ctx: WindowContext, tabs: TabsSnapshot) => Partial<ShellState>
  /** Calls `push` when the part's source changes; returns the stop, run when the window closes. */
  watch?: (ctx: WindowContext, push: () => void) => () => void
}

/** One line per feature, alphabetical by name. */
export const SHELL_STATE_PARTS: readonly ShellStatePart[] = [
  addressBarStatePart,
  bookmarkedStatePart,
  contentBlockedStatePart,
  downloadsStatePart,
  extensionsStatePart,
  groupsStatePart,
  homeStatePart,
  loginsStatePart,
  popupsBlockedStatePart,
  shortcutsStatePart,
  sidePanelStatePart,
  siteAccessStatePart
]

/** What every part adds to a push, merged. A part that throws adds nothing to that push. */
export function readStateParts (ctx: WindowContext, tabs: TabsSnapshot, parts: readonly ShellStatePart[] = SHELL_STATE_PARTS): Partial<ShellState> {
  return Object.assign({}, ...parts.map((part) => contain(`state part ${part.name}`, {}, () => part.read(ctx, tabs)))) as Partial<ShellState>
}

/** Starts every part's watcher; the returned function stops them all. A watcher that throws, on start or on stop, is skipped. */
export function watchStateParts (ctx: WindowContext, push: () => void, parts: readonly ShellStatePart[] = SHELL_STATE_PARTS): () => void {
  const stops = parts.flatMap((part) => {
    const stop = part.watch === undefined ? undefined : contain(`state part ${part.name} watch`, undefined, () => part.watch?.(ctx, push))
    return stop === undefined ? [] : [() => { contain(`state part ${part.name} stop`, undefined, stop) }]
  })
  return () => { for (const stop of stops) stop() }
}
