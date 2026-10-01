// A tab given pages behind it: a copy of a tab, and a tab brought back from the last session. Back goes where Back
// in the original would.
import type { WebContents } from 'electron'

/**
 * Gives `wc` a back and forward list, ending on entry `index`. The load its tab was created with is stopped
 * first: left running, it commits as one more entry after the restored ones and the page loads twice. Electron
 * leaves the restored entry unloaded, so the reload is what loads it (once). A list that cannot be restored
 * leaves the tab on its address alone and answers false.
 */
export function restoreHistory (wc: WebContents, entries: ReadonlyArray<{ readonly url: string, readonly title: string }>, index: number): boolean {
  try {
    wc.stop()
    wc.navigationHistory.restore({ entries: entries.map(({ url, title }) => ({ url, title })), index }).catch(() => {})
    wc.reload()
    return true
  } catch {
    // The tab already loads its address.
    return false
  }
}

/** Gives `to` the session history of `from`, with the same page current. Only the address and title of each entry
 * travel: an entry's saved page state holds form values and a form's POST body, which a copy must not resubmit or
 * show. A history of one page has nothing to carry. When `expectedUrl` is given the list is carried only if
 * that is the page `from` is on: a swap made before the address has committed leaves `from` on the page being left,
 * and restoring that list would load the wrong page. True when `to` was given the list and loads its current page. */
export function carryHistory (from: WebContents | undefined, to: WebContents | undefined, expectedUrl?: string): boolean {
  if (from === undefined || to === undefined) return false
  const entries = from.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title }))
  const index = from.navigationHistory.getActiveIndex()
  if (entries.length < 2 || index < 0 || index >= entries.length) return false
  if (expectedUrl !== undefined && entries[index]?.url !== expectedUrl) return false
  return restoreHistory(to, entries, index)
}
