// A tab's icon: which of the icons a page announces to try, when what a tab shows is cleared or brought back, and
// the capture that stores the first one that loads. The fetch itself, and the T12 gate it clears, is favicon-fetch.ts.

import type { Session } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { fetchFaviconDataUrlCached } from './favicon-fetch.js'
import { decodeDataUrl, MAX_FAVICON_BYTES, toDataUrl } from './favicon-format.js'

/** At most this many declared candidates are tried, in order, before giving
 * up -- `page-favicon-updated` can hand back several sizes/formats of the
 * same icon, and the first one to actually decode should win without an
 * unbounded number of fetches for one navigation. */
export const MAX_FAVICON_CANDIDATES = 4

/**
 * Every http(s) or `data:` URL out of `page-favicon-updated`'s candidate
 * list, in declared order, capped at MAX_FAVICON_CANDIDATES. Electron's own
 * event should only ever hand back real page-declared URLs, but every other
 * URL this codebase touches goes through an explicit scheme check
 * (omnibox.ts) rather than trusting the source -- defence in depth, not
 * paranoia about this specific event. A `data:` candidate carries no
 * network reach at all, so it needs no T12 gate downstream -- only decoding
 * and sniffing.
 */
export function faviconCandidates (candidates: readonly string[]): string[] {
  const out: string[] = []
  for (const candidate of candidates) {
    if (/^(?:https?|data):/i.test(candidate)) out.push(candidate)
    if (out.length === MAX_FAVICON_CANDIDATES) break
  }
  return out
}

/**
 * True if favicon state captured under `previousOrigin` should be
 * cleared before a page at `nextUrl` is shown. Lives here rather than in
 * tabs.ts, its only caller, so it stays reachable from a plain vitest
 * import -- tabs.ts has a VALUE import of `WebContentsView` from
 * 'electron', which this module never does (see the file header).
 *
 * `page-favicon-updated` only fires when Chromium's favicon SET
 * actually changes, so a same-origin navigation to a page with the
 * identical icon fires nothing -- clearing on every commit would leave
 * those stuck on the globe forever. Callers should wire this to
 * 'did-navigate' (top-level commits) only; a hash-only or pushState
 * change ('did-navigate-in-page') should never reach it, since it's
 * still logically the same page.
 */
export function shouldClearFavicon (previousOrigin: string | null, nextUrl: string): boolean {
  if (previousOrigin === null) return false
  try {
    // An opaque-origin URL (about:blank, the fallback every rejected
    // navigation lands on) does NOT throw here -- `.origin` resolves to
    // the literal string "null" per the URL spec, which then simply
    // compares unequal to any real captured origin below. The catch
    // below is for a string that isn't parseable as a URL at all, which
    // no current caller actually produces (tabs.ts only ever passes a
    // committed navigation's own URL) but is cheap to guard regardless.
    return new URL(nextUrl).origin !== previousOrigin
  } catch {
    return true
  }
}

/** How many sites' icons a tab keeps to show again: a tab goes back and forth between a few, not a long list. */
const REMEMBERED_SITES = 4
/** Per tab, in memory only: what the tab last showed for each origin, an icon it fetched or `null` for the globe
 * when none of the page's own icons loaded. Never written anywhere. */
const shownIcons = new WeakMap<object, Map<string, string | null>>()

function rememberIcon (target: FaviconTarget, origin: string, dataUrl: string | null): void {
  const icons = shownIcons.get(target) ?? new Map<string, string | null>()
  icons.delete(origin)
  icons.set(origin, dataUrl)
  while (icons.size > REMEMBERED_SITES) icons.delete(icons.keys().next().value as string)
  shownIcons.set(target, icons)
}

/**
 * What the tab's icon is as a page at `nextUrl` commits. Clears it as `shouldClearFavicon` says, then, with none
 * shown, brings back what this tab last showed for that origin, an icon or the globe, else `saved(nextUrl)` (the icon
 * history keeps for the site): the browser announces an icon only when the set of icons changes, so a return after
 * a blank page or an error page would announce nothing and leave the globe. A real change of icon is announced and
 * replaces what is shown here; an announced set none of which loads shows the globe (captureFaviconInto).
 */
export function faviconOnCommit (target: FaviconTarget, nextUrl: string, saved: (url: string) => string | null = () => null): void {
  if (shouldClearFavicon(target.faviconOrigin, nextUrl)) {
    target.favicon = null
    target.faviconOrigin = null
  }
  if (target.favicon !== null || target.faviconOrigin !== null) return
  let origin: string
  try {
    origin = new URL(nextUrl).origin
  } catch {
    return
  }
  if (origin === 'null') return
  const remembered = shownIcons.get(target)
  const icon = remembered?.has(origin) === true ? remembered.get(origin) ?? null : saved(nextUrl)
  if (icon === null) {
    // A globe the tab remembers is the page's own answer, so the site's icon from history must not replace it.
    if (remembered?.has(origin) === true) target.faviconOrigin = origin
    return
  }
  target.favicon = icon
  target.faviconOrigin = origin
}

/** The mutable favicon slice of a tab record. `TabRecord` (tab-types.ts)
 * satisfies this structurally, so nothing has to adapt it. */
export interface FaviconTarget {
  favicon: string | null
  faviconOrigin: string | null
  pendingFaviconUrl: string | null
}

/** A `data:` candidate needs no network and so no T12 gate -- only decoding
 * and the same byte-sniff every fetched candidate goes through (toDataUrl),
 * so a mislabelled or garbled `data:` icon is refused exactly like a
 * mislabelled network one, rather than trusted because it already claimed
 * to be an image. */
function decodedDataUrlCandidate (candidate: string): string | null {
  const bytes = decodeDataUrl(candidate, MAX_FAVICON_BYTES)
  return bytes === null ? null : toDataUrl(bytes)
}

/** Tries each candidate from `page-favicon-updated`, in order, and stores
 * the first one that actually decodes to a recognised image, unless the
 * tab has since closed, a newer icon set has arrived, or the tab has moved
 * to another origin. When none does, the tab shows the globe, as Chrome does.
 *
 * `pageUrl` is read ONCE, at the start, for the document that fired the
 * event: it decides whether a loopback candidate may be fetched at all
 * (isSafeFaviconUrl), and its origin is what `faviconOrigin` records -- the
 * DECLARING PAGE's origin, never the icon resource's own (a CDN, commonly),
 * which shouldClearFavicon depends on.
 *
 * All three are re-checked after every await, with `pageUrl()` read fresh.
 * Chromium fires `page-favicon-updated` only when a page's icon set
 * differs from the last one (a page declaring none gets `/favicon.ico`), so
 * a newer set moves `pendingFaviconUrl` on, while a hash change, a
 * pushState, or a same-origin page with the same set fires nothing: the
 * icon being fetched is that page's icon too, so a same-origin change must
 * not drop it. Another origin is what shouldClearFavicon clears, and the
 * same rule stops a still-running call from writing onto it.
 *
 * `pageSession` is the session the page loaded in, which its own-origin icons are fetched through (sessionForHop).
 */
export async function captureFaviconInto (
  target: FaviconTarget,
  favicons: readonly string[],
  pageUrl: () => string,
  isStillCurrent: () => boolean,
  onUpdated: () => void,
  pageSession?: Session
): Promise<void> {
  const candidates = faviconCandidates(favicons)
  if (candidates.length === 0) return

  const declaringPage = pageUrl()
  let declaringOrigin: string
  try {
    declaringOrigin = new URL(declaringPage).origin
  } catch {
    return
  }
  const stillTheSamePage = (): boolean => isStillCurrent() && !shouldClearFavicon(declaringOrigin, pageUrl())

  for (const candidate of candidates) {
    if (!stillTheSamePage()) return
    target.pendingFaviconUrl = candidate
    const stillWanted = (): boolean => stillTheSamePage() && target.pendingFaviconUrl === candidate

    // Case-insensitively too: faviconCandidates' own scheme filter is
    // case-insensitive (a page may spell it `DATA:`), and a candidate that
    // qualified there must be decoded the same way here, never silently
    // fall through to a network fetch that can only ever refuse it (a
    // `data:` URL has no hostname, so isSafeFaviconUrl never accepts one).
    const dataUrl = /^data:/i.test(candidate)
      ? decodedDataUrlCandidate(candidate)
      : await fetchFaviconDataUrlCached(candidate, declaringPage, stillWanted, pageSession)

    if (!stillWanted()) return
    if (dataUrl === null) continue

    target.favicon = dataUrl
    target.faviconOrigin = declaringOrigin
    rememberIcon(target, declaringOrigin, dataUrl)
    onUpdated()
    return
  }

  // None of the page's own icons loaded, so it shows the globe over whatever the tab kept for the site. The origin
  // stays recorded so that faviconOnCommit does not restore that icon on a later same-site page announcing nothing.
  target.faviconOrigin = declaringOrigin
  // Except on a host the verifier serves: there a failure is gateways too slow to answer in time, not a page without
  // an icon, so the site's icon the tab already shows stays.
  if (target.favicon !== null && BUILTIN_ADDRESSES.routesToVerifier(new URL(declaringPage).hostname)) return
  rememberIcon(target, declaringOrigin, null)
  if (target.favicon === null) return
  target.favicon = null
  onUpdated()
}
