// A tab given pages behind it: a copy of a tab, and a tab brought back from the last session. Back goes where Back
// in the original would.
import type { WebContents } from 'electron'
import { isShellSchemeUrl } from './shell-session.js'
import { noteCommit } from './tab-outer-history.js'
import type { HistoryEntry, OuterHistory } from './tab-outer-history.js'

/**
 * `entries` without the shell's own pages, `index` moved to the entry that was shown. Null when the shown entry
 * is one of them or `index` is out of range. The shell's pages are served in one session only
 * (../pages/shell-scheme.ts), so in a copy, a swapped view or a woken tab they would be an entry Back reaches
 * and nothing answers.
 */
export function withoutShellPages<T extends { readonly url: string }> (entries: readonly T[], index: number): { entries: T[], index: number } | null {
  const shown = entries[index]
  if (shown === undefined || isShellSchemeUrl(shown.url)) return null
  return {
    entries: entries.filter(({ url }) => !isShellSchemeUrl(url)),
    index: entries.slice(0, index).filter(({ url }) => !isShellSchemeUrl(url)).length
  }
}

/**
 * Gives `wc` a back and forward list, ending on entry `index`. The load its tab was created with is stopped
 * first: left running, it commits as one more entry after the restored ones and the page loads twice. Electron
 * leaves the restored entry unloaded, so the reload is what loads it (once). With `then` the list is restored
 * as it stands and that address is loaded after it, as one more entry. Entries on the shell's own scheme are
 * left out, the index shifted to match; a list whose shown entry is one is not restored. A list that cannot be
 * restored leaves the tab on its address alone and answers false.
 */
export function restoreHistory (wc: WebContents, entries: ReadonlyArray<{ readonly url: string, readonly title: string }>, index: number, then?: string): boolean {
  const kept = withoutShellPages(entries, index)
  if (kept === null) return false
  try {
    wc.stop()
    wc.navigationHistory.restore({ entries: kept.entries.map(({ url, title }) => ({ url, title })), index: kept.index }).catch(() => {})
    if (then === undefined) wc.reload()
    else void wc.loadURL(then)
    return true
  } catch {
    // The tab already loads its address.
    return false
  }
}

/** Gives `to` the session history of `from`, with the same page current. Only the address and title of each entry
 * travel: an entry's saved page state holds form values and a form's POST body, which a copy must not resubmit or
 * show. A history of one page has nothing to carry. When `expectedUrl` is given and `from` is not yet on it (a swap
 * made before the address has committed), the pages `from` has been through are carried up to the one it is on, and
 * `expectedUrl` loads after them, so Back returns to that page. True when `to` was given the list and loads its
 * current page. */
export function carryHistory (from: WebContents | undefined, to: WebContents | undefined, expectedUrl?: string): boolean {
  if (from === undefined || to === undefined) return false
  const entries = from.navigationHistory.getAllEntries().map(({ url, title }) => ({ url, title }))
  const index = from.navigationHistory.getActiveIndex()
  if (index < 0 || index >= entries.length) return false
  if (expectedUrl !== undefined && entries[index]?.url !== expectedUrl) {
    if (entries[index]?.url === 'about:blank') return false
    return restoreHistory(to, entries.slice(0, index + 1), index, expectedUrl)
  }
  if (entries.length < 2) return false
  return restoreHistory(to, entries, index)
}

/** `wc`'s back and forward list, address and title only, and the entry it shows. */
export function listOf (wc: WebContents): { entries: HistoryEntry[], index: number } {
  const history = wc.navigationHistory
  return { entries: history.getAllEntries().map(({ url, title }) => ({ url, title })), index: history.getActiveIndex() }
}

/** The tab's view committed a page (`sameDocument` for a fragment or `pushState` change). A view that has just
 * stepped out of its list, or a parked view the tab came back to, is left holding that page alone: its other pages
 * are in the tab's outer history already, and going back to the page a parked app left for would load it inside the
 * app's session. A parked view's own blank page committing late is not the page it came back for. */
export function settleOuterHistory (record: { outer?: OuterHistory }, wc: WebContents, url: string, sameDocument = false): void {
  let outer = record.outer
  if (outer === undefined) return
  // A step in the tab's own view has committed (load-in-tab.ts's `stepOutOfView`).
  if (outer.pending !== undefined && !sameDocument && url !== 'about:blank') outer = outer.pending
  const history = wc.navigationHistory
  if (outer.trimOnCommit === true) {
    if (sameDocument || url === 'about:blank') return
    const active = history.getActiveIndex()
    // From the end, so each removal leaves the indices still to visit alone.
    for (let index = history.length() - 1; index >= 0; index--) if (index !== active) history.removeEntryAtIndex(index)
  }
  record.outer = noteCommit(outer, history.getAllEntries().map((entry) => entry.url), history.getActiveIndex())
}
