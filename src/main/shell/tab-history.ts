// A copy of a tab keeps the pages behind it: Back in the copy goes where Back in the original would.
import type { WebContents } from 'electron'

/** Gives `to` the session history of `from`, with the same page current. Only the address and title of each entry
 * travel: an entry's saved page state holds form values and a form's POST body, which a copy must not resubmit or
 * show. A history of one page has nothing to carry. */
export function carryHistory (from: WebContents | undefined, to: WebContents | undefined): void {
  if (from === undefined || to === undefined) return
  const entries = from.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title }))
  const index = from.navigationHistory.getActiveIndex()
  if (entries.length < 2 || index < 0 || index >= entries.length) return
  to.navigationHistory.restore({ entries, index }).catch(() => {})
}
