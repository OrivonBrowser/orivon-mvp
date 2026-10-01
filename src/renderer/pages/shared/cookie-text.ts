// The words a cookie row says, for the site-info popover and the Settings list: where it applies and when it
// goes, never its value (main does not send one). Pure: no DOM.
import type { CookieView } from '../../../main/privacy/cookie-list.js'

export type CookieMeta = Pick<CookieView, 'domain' | 'session' | 'expires'>

/** The most cookies a list draws before it says how many more there are. */
export const COOKIES_SHOWN = 50

export function expiryText (cookie: Pick<CookieMeta, 'session' | 'expires'>, locale?: string): string {
  if (cookie.session || cookie.expires === null) return 'until you close Orivon'
  const date = new Date(cookie.expires * 1000).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
  return `expires ${date}`
}

/** `.example.com · expires 12 Mar 2027`. */
export function cookieMeta (cookie: CookieMeta, locale?: string): string {
  return `${cookie.domain} · ${expiryText(cookie, locale)}`
}

export function flagsOf (cookie: Pick<CookieView, 'secure' | 'httpOnly'>): string[] {
  return [...(cookie.secure ? ['Secure'] : []), ...(cookie.httpOnly ? ['HttpOnly'] : [])]
}

/** What to draw of a list, and the line for the rest: null when all of it shows. */
export function shownOf<T> (items: readonly T[], limit = COOKIES_SHOWN): { readonly shown: readonly T[], readonly more: string | null } {
  return { shown: items.slice(0, limit), more: items.length > limit ? `and ${String(items.length - limit)} more` : null }
}

export function countText (count: number): string {
  return `${String(count)} ${count === 1 ? 'cookie' : 'cookies'}`
}
