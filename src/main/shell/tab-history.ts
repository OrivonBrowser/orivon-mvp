// A tab given pages behind it: a copy of a tab, and a tab brought back from the last session. Back goes where Back
// in the original would.
import type { WebContents } from 'electron'

/**
 * Gives `wc` a back and forward list, ending on entry `index`. The load its tab was created with is stopped
 * first: left running, it commits as one more entry after the restored ones and the page loads twice. Electron
 * leaves the restored entry unloaded, so the reload is what loads it (once). A list that cannot be restored
 * leaves the tab on its address alone.
 */
export function restoreHistory (wc: WebContents, entries: ReadonlyArray<{ readonly url: string, readonly title: string }>, index: number): void {
  try {
    wc.stop()
    wc.navigationHistory.restore({ entries: entries.map(({ url, title }) => ({ url, title })), index }).catch(() => {})
    wc.reload()
  } catch {
    // The tab already loads its address.
  }
}

/** Gives `to` the session history of `from`, with the same page current. Only the address and title of each entry
 * travel: an entry's saved page state holds form values and a form's POST body, which a copy must not resubmit or
 * show. A history of one page has nothing to carry. */
export function carryHistory (from: WebContents | undefined, to: WebContents | undefined): void {
  if (from === undefined || to === undefined) return
  const entries = from.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title }))
  const index = from.navigationHistory.getActiveIndex()
  if (entries.length < 2 || index < 0 || index >= entries.length) return
  restoreHistory(to, entries, index)
}
