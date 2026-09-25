// The discovery trigger's page-side half: notices a <link
// rel="orivon-manifest"> hint already present in the page's own delivered
// HTML and reports its href to main over MANIFEST_HINT_CHANNEL --
// ../loader/README.md's "Never probe automatically" is why this is the ONLY
// thing that ever leads to a well-known manifest fetch; nothing here fetches
// anything itself, it only notices and reports.
//
// Runs in the isolated world, same as every other file in this directory --
// reading `document` here is safe (the isolated and main worlds share one
// DOM), and it is exactly why this belongs in preload rather than main:
// main has no DOM to read at all.

import { ipcRenderer } from 'electron'
import { MANIFEST_HINT_CHANNEL } from '../main/channels.js'

const MANIFEST_HINT_SELECTOR = 'link[rel~="orivon-manifest"]'

/** The one shape this file needs from a document -- structural, like
 * ../broker/policy/origin.ts's SenderFrameLike, so a test builds a plain
 * object instead of a real DOM (vitest.config.ts runs every test in Node,
 * with no jsdom). */
export interface HintDocument {
  readonly readyState: string
  addEventListener: (type: string, listener: () => void, options?: { once?: boolean }) => void
  querySelectorAll: (selectors: string) => Iterable<{ readonly href: string }>
}

/**
 * The first `<link rel="orivon-manifest">`'s `href` in `doc`, in document
 * order -- STRICTLY the first matching element, not the first with a
 * non-empty `href`: a page whose only hint is malformed (no `href`
 * attribute) is treated as carrying no hint at all, never as a reason to
 * keep looking further down the document. "First hint wins" is applied
 * literally, not "first valid hint wins".
 *
 * `.href` is the DOM's own resolved, absolute-URL IDL accessor -- never
 * `getAttribute('href')`, which would hand back whatever possibly-relative
 * string the page wrote, resolved against a base URL a page's own `<base>`
 * tag could have moved by the time anything else looked at it.
 *
 * `rel~=` (not a plain `rel=` match) is the CSS attribute selector for "one
 * of these space-separated tokens" -- `rel` is a token list per the HTML
 * spec, so `rel="preload orivon-manifest"` is as much a hint as
 * `rel="orivon-manifest"` alone, matching how a real browser already reads
 * `rel` for `stylesheet`, `preconnect`, and everything else.
 */
export function firstManifestHintHref (doc: HintDocument): string | null {
  const [first] = doc.querySelectorAll(MANIFEST_HINT_SELECTOR)
  if (first === undefined || first.href.length === 0) return null
  return first.href
}

/**
 * Wires the whole discovery trigger into `doc`, reporting through `send`.
 *
 * SCANS AT MOST ONCE PER CALL -- which in practice means at most once per
 * navigation, since a preload script re-runs fresh on every one
 * (app.ts's own header) -- and never re-scans afterward, so a `<link>` a
 * script inserts once the page has already loaded is never seen. That is
 * the deliberate, stated choice for "a page can inject more after load":
 * the trigger is a hint in HTML the page already delivered
 * (../loader/README.md), not anything added later, and a MutationObserver
 * watching indefinitely for more hints would turn one page visit into an
 * open-ended probe -- exactly what that README section forbids.
 *
 * This is also the FIRST of two independent bounds against a page trying to
 * repeat the trigger: the second is main's own per-origin rate limit
 * (../main/manifest-hint.ts), which bounds a page reloading ITSELF to fire
 * this again across separate navigations -- a case this function alone
 * cannot see, since each reload re-runs preload with a fresh, unlatched
 * `reported` flag.
 *
 * Waits for `DOMContentLoaded` if the document is still parsing, so a hint
 * a synchronous inline script adds while the page loads is still seen --
 * scans immediately otherwise.
 */
export function watchForManifestHint (doc: HintDocument, send: (href: string) => void): void {
  let reported = false
  function scan (): void {
    if (reported) return
    reported = true
    const href = firstManifestHintHref(doc)
    if (href !== null) send(href)
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', scan, { once: true })
  } else {
    scan()
  }
}

/**
 * The real, zero-argument entry point -- app.ts and newtab.ts's fallback
 * branch both call this exactly once, the same way they each call
 * ./surface/orivon.ts's exposeOrivon() exactly once.
 *
 * `typeof document === 'undefined'` guards the same way routed/fetch.ts's own
 * `target` default does: referencing the bare identifier is safe under
 * `typeof`, but not otherwise, in an environment (a plain vitest run) with
 * no such global at all.
 */
export function installManifestHintWatcher (): void {
  if (typeof document === 'undefined') return
  watchForManifestHint(document, (href) => { ipcRenderer.send(MANIFEST_HINT_CHANNEL, href) })
}
