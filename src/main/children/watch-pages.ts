// Feeds ./page-tracker.ts from every real page the process makes -- the same
// `web-contents-created` + `getType() === 'window'` filter install-history.ts
// and install-zoom.ts already use, which is what makes the host's own
// offscreen WebContentsView (getType() === 'offscreen') invisible to this
// tracker with no special case: it is never a 'window'.

import type { App, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { PageTracker } from './page-tracker.js'

/** The origin each tracked WebContents last committed, or null before its
 * first document (about:blank) or after it has closed -- so a second
 * `destroyed`/`render-process-gone` for the same contents, or a navigation
 * that does not change origin, is a no-op rather than a double count. */
const committedOrigin = new WeakMap<WebContents, string | null>()

/**
 * ALWAYS closes the previous document's origin before opening the new one's,
 * even when they are the SAME origin: `did-navigate` fires once per document,
 * a reload included, and a reload must pass through zero for an app's only
 * page (ADR-0046: "reloading the only page ends its children"). Only
 * `did-navigate-in-page`, which this file never listens for, must not.
 */
function commit (contents: WebContents, tracker: PageTracker, url: string): void {
  const prev = committedOrigin.get(contents) ?? null
  if (prev !== null) tracker.recordPageClosed(prev)
  const next = originFromUrl(url)
  committedOrigin.set(contents, next)
  if (next !== null) tracker.recordPageOpened(next)
}

function release (contents: WebContents, tracker: PageTracker): void {
  const origin = committedOrigin.get(contents) ?? null
  if (origin === null) return
  committedOrigin.set(contents, null)
  tracker.recordPageClosed(origin)
}

/** Wires every 'window' WebContents the process ever makes into `tracker`. */
export function watchPages (app: Pick<App, 'on'>, tracker: PageTracker): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return
    // A new document at the same origin the tab already showed (a reload)
    // still runs this: recordPageClosed then recordPageOpened for the SAME
    // origin, so a reload of an app's only page passes through zero and
    // fires onceEmpty -- exactly the "reloading the only page ends its
    // children" rule (ADR-0046).
    contents.on('did-navigate', (_navigateEvent, url) => { commit(contents, tracker, url) })
    contents.on('destroyed', () => { release(contents, tracker) })
    contents.on('render-process-gone', () => { release(contents, tracker) })
  })
}
