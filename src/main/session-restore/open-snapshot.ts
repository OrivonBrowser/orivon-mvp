// Opens a saved tab in a window: the one place an address from the closed stack or the session file becomes a tab.
import { gatewayEntries } from '../shell/eth-gateway-rule.js'
import { restoreHistory } from '../shell/tab-history.js'
import type { TabManager } from '../shell/tabs.js'
import { showTitleUntilLoaded } from './restored-title.js'
import { rememberOpenedFrom, sanitizeSnapshot } from './tab-snapshot.js'
import type { TabSnapshot } from './tab-snapshot.js'

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
    if (opened.created && record !== undefined) {
      record.pinned = clean.pinned
      rememberOpenedFrom(record, clean)
    }
    return opened.id
  }
  const id = tabs.createTab(clean.url, active)
  const record = tabs.record(id)
  if (record === undefined) return undefined
  record.pinned = clean.pinned
  showTitleUntilLoaded(record, clean.title)
  rememberOpenedFrom(record, clean)
  // The view was built for the address the tab opened as, which can be a session no web-request handler covers.
  if (clean.entries !== undefined && clean.index !== undefined) restoreHistory(record.view.webContents, gatewayEntries(record.host.services?.settings, clean.entries), clean.index)
  return id
}
