// What the tab menu and the tab commands do to one tab or to the others around it. Each takes the tab's id:
// the menu acts on the tab that was right-clicked, a command on the one in front.
import { applyMuted } from './signals/audio.js'
import { gatewayEntries } from './eth-gateway-redirect.js'
import { carryHistory, restoreHistory } from './tab-history.js'
import { setPinned } from './tab-pin.js'
import type { TabMenuModel } from './tab-menu.js'
import type { TabState } from './tab-types.js'
import type { TabManager } from './tabs.js'

/** The part of a tab's state these decisions read, so they run over a hand-made strip in a test. */
type Strip = { readonly tabs: ReadonlyArray<Pick<TabState, 'id' | 'pinned' | 'splitWith'>> }
type MenuStrip = { readonly tabs: ReadonlyArray<Pick<TabState, 'id' | 'pinned' | 'splitWith' | 'muted' | 'isNewTab' | 'isInternal'>> }

/** Where the tab, with the one it is joined to, ends: the last place either holds in the strip. */
function endOf (state: Strip, id: string): number {
  const tab = state.tabs.find((candidate) => candidate.id === id)
  const partner = tab?.splitWith ?? null
  return Math.max(state.tabs.findIndex((candidate) => candidate.id === id), partner === null ? -1 : state.tabs.findIndex((candidate) => candidate.id === partner))
}

/** The tabs "Close Other Tabs" closes: every one but `id` that is not pinned. */
export function othersToClose (state: Strip, id: string): string[] {
  return state.tabs.filter((tab) => tab.id !== id && !tab.pinned).map((tab) => tab.id)
}

/** The tabs "Close Tabs to the Right" closes: the unpinned ones after `id`, and after the tab it is joined to. */
export function rightToClose (state: Strip, id: string): string[] {
  const from = endOf(state, id)
  return from === -1 ? [] : state.tabs.slice(from + 1).filter((tab) => !tab.pinned).map((tab) => tab.id)
}

/** Closes `ids`, first going to `id` when the tab in front is among them: the tab the person pointed at is the
 * one they are left on, not whichever neighbour the strip falls back to. */
function closeAllBut (tabs: TabManager, id: string, ids: readonly string[]): void {
  if (ids.length === 0) return
  const active = tabs.getState().activeTabId
  if (active !== null && ids.includes(active)) tabs.activateTab(id)
  for (const other of ids) tabs.closeTab(other)
}

/** What the tab menu's enabled states and labels read off the strip, for the tab `id`; undefined for a tab that is gone. */
export function tabMenuFlags (state: MenuStrip, id: string): Pick<TabMenuModel, 'canDuplicate' | 'pinned' | 'muted' | 'canPin' | 'othersClosable' | 'rightClosable'> | undefined {
  const tab = state.tabs.find((candidate) => candidate.id === id)
  if (tab === undefined) return undefined
  return {
    canDuplicate: !tab.isInternal && !tab.isNewTab,
    pinned: tab.pinned,
    muted: tab.muted,
    canPin: tab.splitWith === null,
    othersClosable: othersToClose(state, id).length > 0,
    rightClosable: rightToClose(state, id).length > 0
  }
}

export function closeOthers (tabs: TabManager, id: string): void {
  closeAllBut(tabs, id, othersToClose(tabs.getState(), id))
}

export function closeToRight (tabs: TabManager, id: string): void {
  closeAllBut(tabs, id, rightToClose(tabs.getState(), id))
}

export function toggleMute (tabs: TabManager, id: string): void {
  const record = tabs.record(id)
  if (record === undefined) return
  record.muted = record.muted !== true
  applyMuted(record)
  tabs.changed()
}

export function togglePin (tabs: TabManager, id: string): void {
  const record = tabs.record(id)
  if (record !== undefined) setPinned(tabs, id, record.pinned !== true)
}

/** A new tab, in front, right of the tab (and of the one it is joined to): an unpinned one, so beside a pinned
 * tab it opens where the pinned run ends. `url` absent opens the new-tab page. */
export function openBeside (tabs: TabManager, id: string, url?: string): string | undefined {
  if (!tabs.hasRoom()) return undefined
  const at = endOf(tabs.getState(), id) + 1
  const created = tabs.createTab(url)
  // Beside a tab of a group, it is in that group too.
  const fresh = tabs.record(created)
  if (fresh !== undefined && created !== id) fresh.groupId = tabs.record(id)?.groupId ?? null
  tabs.moveTab(created, at)
  return created
}

export function newTabToRight (tabs: TabManager, id: string): void {
  openBeside(tabs, id)
}

/** Copies the tab, with the pages behind it, into a new tab beside it: not the new-tab page or one of the shell's
 * own pages, which a copy would only repeat or, for Settings, reopen. */
export function duplicateTab (tabs: TabManager, id: string): void {
  const tab = tabs.getState().tabs.find((candidate) => candidate.id === id)
  if (tab === undefined || tab.isNewTab || tab.isInternal) return
  const created = openBeside(tabs, id, tab.url)
  if (created === undefined) return
  // A sleeping tab's view never loaded: its pages are the ones it kept when it went to sleep.
  const kept = tabs.record(id)?.sleeping
  const copy = tabs.liveWebContents(created)
  if (kept == null) carryHistory(tabs.liveWebContents(id), copy)
  else if (kept.entries.length > 1 && copy !== undefined) restoreHistory(copy, gatewayEntries(tabs.record(created)?.host.services?.settings, kept.entries), kept.index)
}
