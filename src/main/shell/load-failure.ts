// Whether the page a tab shows is Chromium's error page for a navigation that failed (a rejected certificate, a name that
// does not resolve, a refused connection). Chromium commits that page under the address that failed, so its URL reads as
// a live https site: the lock must not be drawn for it.
import type { WebContents } from 'electron'

/** A navigation that was cancelled (by a newer one, or by the person) is not a failure of the page. */
const ERR_ABORTED = -3

interface Tracking {
  /** The main-frame navigations begun so far. */
  started: number
  /** The navigation whose failure is showing, or null when the page is not an error page. */
  failedAt: number | null
}

const tracking = new WeakMap<WebContents, Tracking>()

/** Whether the page now showing is the error page of a failed main-frame load. */
export function loadFailed (contents: WebContents | undefined): boolean {
  return contents !== undefined && (tracking.get(contents)?.failedAt ?? null) !== null
}

/** Follows `contents`. `changed` runs when a failure is recorded, so the state that reads it is pushed again. The flag
 * stays until a later navigation commits: nothing between a failure and then redraws a lock over the error page. */
export function watchLoadFailure (contents: WebContents, changed: () => void): void {
  const state: Tracking = { started: 0, failedAt: null }
  tracking.set(contents, state)
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) state.started += 1
  })
  contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return
    state.failedAt = state.started
    changed()
  })
  contents.on('did-navigate', () => {
    // The error page itself may be announced as a navigation: that one is the failed navigation, not a recovery.
    if (state.failedAt !== null && state.failedAt !== state.started) {
      state.failedAt = null
      changed()
    }
  })
}
