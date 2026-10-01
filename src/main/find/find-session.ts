// One tab's find state, as pure functions: what to ask the page for next, and
// which answers to believe. The calls themselves are ./find-runner.ts.

/** The options `findInPage` takes, as this feature uses them. */
export interface FindCall {
  readonly text: string
  readonly options: { readonly findNext: boolean, readonly forward: boolean, readonly matchCase: boolean }
}

export interface FindSession {
  query: string
  matchCase: boolean
  /** The id `findInPage` returned for the newest call: an answer for an older id is stale. */
  requestId: number
  /** True once a `findNext: true` call ran on the tab's current page; a navigation or a swapped view resets it. */
  started: boolean
  active: number
  total: number
  /** A step to take as soon as the first answer of a fresh search is in (Find next with the bar closed). */
  pendingStep: boolean | null
  /** The bar was closed by a tab switch: it comes back when the tab does. */
  reopen: boolean
}

/** What the page shows for one accepted answer. */
export interface FindResult { readonly active: number, readonly total: number }

/** The parts of Electron's `Result` this feature reads. */
export interface FoundInPage { readonly requestId: number, readonly activeMatchOrdinal: number, readonly matches: number, readonly finalUpdate: boolean }

export function newSession (query = '', matchCase = false): FindSession {
  return { query, matchCase, requestId: 0, started: false, active: 0, total: 0, pendingStep: null, reopen: false }
}

/** A new search: the first match becomes the active one. */
export function beginCall (session: FindSession, text: string, matchCase: boolean): FindCall {
  session.query = text
  session.matchCase = matchCase
  session.started = true
  session.active = 0
  session.total = 0
  session.pendingStep = null
  return { text, options: { findNext: true, forward: true, matchCase } }
}

/** The next or previous match, or null with nothing to look for. A search that never ran on this page begins instead. */
export function stepCall (session: FindSession, forward: boolean): FindCall | null {
  if (session.query === '') return null
  if (!session.started) {
    const call = beginCall(session, session.query, session.matchCase)
    return { text: call.text, options: { ...call.options, forward } }
  }
  return { text: session.query, options: { findNext: false, forward, matchCase: session.matchCase } }
}

/** After a navigation or a view swap: the old page's matches are gone, so the next call begins again. */
export function invalidate (session: FindSession): void {
  session.started = false
  session.active = 0
  session.total = 0
}

/** The answer to show, or null for one that is stale or still counting. */
export function acceptResult (session: FindSession, found: FoundInPage): FindResult | null {
  if (!found.finalUpdate || found.requestId < session.requestId) return null
  session.active = found.activeMatchOrdinal
  session.total = found.matches
  return { active: found.activeMatchOrdinal, total: found.matches }
}
