// Opens a saved tab in a window: the one place an address from the closed stack or the session file becomes a tab.
import type { WebContents } from 'electron'
import type { TabManager } from '../shell/tabs.js'
import { showTitleUntilLoaded } from './restored-title.js'
import { sanitizeSnapshot } from './tab-snapshot.js'
import type { HistoryEntry, TabSnapshot } from './tab-snapshot.js'

/** The id of a tab that was already showing this page of the shell, which opening one more would only duplicate. */
function openInternalPage (tabs: TabManager, page: NonNullable<TabSnapshot['internal']>): { id: string, created: boolean } | undefined {
  const before = new Set(tabs.ids())
  tabs.openInternal(page.page, page.path)
  const id = tabs.ids().find((candidate) => !before.has(candidate))
  if (id !== undefined) return { id, created: true }
  const existing = tabs.ids().find((candidate) => tabs.record(candidate)?.internalPage === page.page)
  return existing === undefined ? undefined : { id: existing, created: false }
}

/**
 * Gives the new tab its back and forward list, ending on the entry that was shown. The load `createTab` just
 * began is stopped first: left running, it commits as one more entry after the restored ones. Electron then
 * leaves the restored entry unloaded, so the reload is what loads it (once). A list that cannot be restored
 * leaves the tab on its address alone.
 */
function restoreHistory (wc: WebContents, entries: readonly HistoryEntry[], index: number): void {
  try {
    wc.stop()
    wc.navigationHistory.restore({ entries: entries.map(({ url, title }) => ({ url, title })), index }).catch(() => {})
    wc.reload()
  } catch {
    // The tab already loads its address.
  }
}

/**
 * Opens `snapshot` as a new tab, in front when `active`. The snapshot is checked again: it may have been
 * read from a file the person's other programs can write, and only an address a tab could have opened
 * gets here. Returns the tab's id, or undefined when nothing opened.
 */
export function openSnapshot (tabs: TabManager, snapshot: TabSnapshot, active: boolean): string | undefined {
  const clean = sanitizeSnapshot(snapshot)
  if (clean === null || !tabs.hasRoom()) return undefined
  if (clean.internal !== undefined) {
    const opened = openInternalPage(tabs, clean.internal)
    if (opened === undefined) return undefined
    const record = tabs.record(opened.id)
    if (opened.created && record !== undefined) record.pinned = clean.pinned
    return opened.id
  }
  const id = tabs.createTab(clean.url, active)
  const record = tabs.record(id)
  if (record === undefined) return undefined
  record.pinned = clean.pinned
  showTitleUntilLoaded(record, clean.title)
  if (clean.entries !== undefined && clean.index !== undefined) restoreHistory(record.view.webContents, clean.entries, clean.index)
  return id
}
