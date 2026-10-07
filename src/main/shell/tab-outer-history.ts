// The pages of a tab's history that the view it shows does not hold. A view's session is fixed when the view is
// made, so a tab that moves into another session moves into another view, and Electron restores a back and forward
// list only into a view that has loaded nothing (a parked view coming back has). The tab keeps the pages outside its
// view here; Back past the view's first page and Forward past its last step into them, one page at a time, each
// loaded in a view of its own session (tab-parking.ts's `stepOutOfView`). Pure.
import { originFromUrl } from '../../broker/policy/origin.js'

export interface HistoryEntry { readonly url: string, readonly title: string }

export interface OuterHistory {
  /** Oldest first: the last one is what Back past the view reaches. */
  readonly back: readonly HistoryEntry[]
  /** Nearest first: the first one is what Forward past the view reaches. */
  readonly forward: readonly HistoryEntry[]
  /** The view's next commit leaves it holding that page alone: its other entries are already in these lists. */
  readonly trimOnCommit?: boolean
  /** The view's list at its last commit, to tell a new page (which ends `forward`) from a step through the list. */
  readonly seen?: { readonly urls: readonly string[], readonly active: number }
  /** The lists a step in the tab's own view leads to, taken once its page commits. */
  readonly pending?: OuterHistory
}

export const EMPTY_OUTER: OuterHistory = { back: [], forward: [] }

/** The most pages a tab keeps outside its view, each way. */
export const OUTER_HISTORY_LIMIT = 50

/** A page a view can be made for and loaded at again: an address with an origin. Not a blank page, a `data:` page,
 * a local file (opened only through the local-files fence) or one of the shell's own pages. */
export function keptInHistory (url: string): boolean {
  return originFromUrl(url) !== null
}

const kept = (entries: readonly HistoryEntry[]): HistoryEntry[] => entries.filter(({ url }) => keptInHistory(url))

/** The tab leaves its view for a view of another session, on a new page. `entries` and `index` are the view being
 * left; `committed` when it already committed that new page (a swap after `did-navigate`), which is then not one
 * of the pages left behind. Pages after `index` stay ahead of it; a new page ends what was ahead of the view. */
export function leaveView (outer: OuterHistory, entries: readonly HistoryEntry[], index: number, committed: boolean): OuterHistory {
  const behind = kept(entries.slice(0, committed ? index : index + 1))
  const ahead = committed && index < entries.length - 1 ? [...kept(entries.slice(index + 1)), ...outer.forward] : []
  return { back: [...outer.back, ...behind].slice(-OUTER_HISTORY_LIMIT), forward: ahead.slice(0, OUTER_HISTORY_LIMIT) }
}

export interface OuterStep { readonly target: HistoryEntry, readonly outer: OuterHistory }

/** Back from the first page of the view: the page before it, with the view's pages now ahead. Null with none. */
export function stepBack (outer: OuterHistory, entries: readonly HistoryEntry[], index: number): OuterStep | null {
  const target = outer.back.at(-1)
  if (target === undefined) return null
  return {
    target,
    outer: { back: outer.back.slice(0, -1), forward: [...kept(entries.slice(index)), ...outer.forward].slice(0, OUTER_HISTORY_LIMIT), trimOnCommit: true }
  }
}

/** Forward from the last page of the view: the page after it, with the view's pages now behind. Null with none. */
export function stepForward (outer: OuterHistory, entries: readonly HistoryEntry[], index: number): OuterStep | null {
  const target = outer.forward[0]
  if (target === undefined) return null
  return {
    target,
    outer: { back: [...outer.back, ...kept(entries.slice(0, index + 1))].slice(-OUTER_HISTORY_LIMIT), forward: outer.forward.slice(1), trimOnCommit: true }
  }
}

/** A new page, rather than a step through the list or the same page again: the list changed length, or it moved
 * to its end onto an address that was not the one there. */
function isNewPage (seen: NonNullable<OuterHistory['seen']>, urls: readonly string[], active: number): boolean {
  if (urls.length !== seen.urls.length) return true
  return active === urls.length - 1 && active !== seen.active && urls[active] !== seen.urls[active]
}

/** The view committed a page. A new one ends the pages ahead of the view, as a new page ends Forward in any
 * browser. The first commit of a view only records its list. */
export function noteCommit (outer: OuterHistory, urls: readonly string[], active: number): OuterHistory {
  const forward = outer.seen !== undefined && isNewPage(outer.seen, urls, active) ? [] : outer.forward
  return { back: outer.back, forward, seen: { urls, active } }
}
