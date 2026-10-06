// How many live tab documents, across every window, currently sit at each
// origin -- split out of tab-view.ts (code-guidelines.md Rule 2) once wiring
// this pushed that file past its line budget. See tab-view.ts's own header
// and README.md's Design notes for how wireView() calls into this.
import type { WebContents } from 'electron'
import { isolationKeyFromUrl } from '../../broker/policy/origin.js'
import type { Broker } from '../../broker/broker-contracts.js'

/**
 * Global, not per `TabManager`, because two windows' tabs on the same
 * origin share one broker origin table (handle-contracts.md's Session
 * teardown section: closing one must not take the other's handles). Backed
 * by two maps rather than one WeakMap-of-counts because a WebContents needs
 * to look up and release the origin it PREVIOUSLY counted toward, not
 * re-derive it from a URL that may already have changed or a WebContents
 * that may already be destroyed.
 */
const liveDocumentsByOrigin = new Map<string, number>()
const countedOriginByWebContents = new WeakMap<WebContents, string>()

function acquireOriginDocument (wc: WebContents, origin: string | null): void {
  if (origin === null) return
  countedOriginByWebContents.set(wc, origin)
  liveDocumentsByOrigin.set(origin, (liveDocumentsByOrigin.get(origin) ?? 0) + 1)
}

/** Drops this WebContents' count against whatever origin it last counted
 * toward, and asks the broker to tear the origin's session down once NONE
 * remain -- never on every release, or two tabs of one origin would have
 * the first tab's close kill the second tab's handles. */
export function releaseOriginDocument (wc: WebContents, broker: Broker | undefined): void {
  const origin = countedOriginByWebContents.get(wc)
  if (origin === undefined) return
  countedOriginByWebContents.delete(wc)
  const remaining = (liveDocumentsByOrigin.get(origin) ?? 1) - 1
  if (remaining > 0) {
    liveDocumentsByOrigin.set(origin, remaining)
    return
  }
  liveDocumentsByOrigin.delete(origin)
  broker?.dropOrigin(origin).catch((error: unknown) => {
    console.error('[orivon] session teardown failed for', origin, error)
  })
}

/**
 * Called on every committed navigation this WebContents makes, shown or
 * parked -- a parked view's own return to `about:blank` (tab-parking.ts's
 * retireView) is a committed navigation too, and is exactly the "navigated
 * to another origin" case handle-contracts.md's Session teardown section
 * names. Origin derivation, not the wired-in `did-navigate` handler's own
 * `shown()` gate, decides whether anything happens: a background tab that
 * navigates still changes which origin's document count it holds.
 */
export function trackDocumentOrigin (wc: WebContents, navigatedUrl: string, broker: Broker | undefined): void {
  const next = isolationKeyFromUrl(navigatedUrl)
  if (next === (countedOriginByWebContents.get(wc) ?? null)) return
  releaseOriginDocument(wc, broker)
  acquireOriginDocument(wc, next)
}
