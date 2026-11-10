// A cookie of the old partition as a cookie of the website session: every attribute it had. Only the app's own cookies are
// carried: the partition also held the cookies of every site the app embedded or called.

/** The part of Electron's `Cookie` the carry reads. */
export interface OldCookie {
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly hostOnly?: boolean
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly session?: boolean
  readonly expirationDate?: number
  readonly sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** The part of Electron's `CookiesSetDetails` the carry writes. */
export interface CookieToSet {
  readonly url: string
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly expirationDate?: number
  readonly sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export type CookiePlan = { readonly kind: 'set', readonly cookie: CookieToSet } | { readonly kind: 'skip', readonly reason: string }

/**
 * What to do with one cookie. A host-only cookie is set without a domain, so that it stays host-only; any other keeps the
 * domain it had. A cookie that has expired is not carried. The address a cookie is set for is built from its own domain and
 * path, since the old partition's cookies are not all for the app's own host.
 */
export function planCookie (cookie: OldCookie, nowSeconds: number): CookiePlan {
  if (cookie.expirationDate !== undefined && cookie.session !== true && cookie.expirationDate <= nowSeconds) return { kind: 'skip', reason: 'expired' }
  const host = (cookie.domain ?? '').replace(/^\./, '')
  if (host === '') return { kind: 'skip', reason: 'no domain' }
  const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path
  return {
    kind: 'set',
    cookie: {
      url: `https://${host}${path}`,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly === true ? {} : { domain: cookie.domain ?? host }),
      path,
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(cookie.session === true || cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite })
    }
  }
}

/**
 * Whether the cookie is one the app at `host` set or could read: host-only on that very host, or a domain cookie whose domain
 * is the host or a parent of it. A cookie of a third party (an embed, a tracker, a sign-in provider the app called) is not.
 */
export function cookieBelongsToHost (cookie: OldCookie, host: string): boolean {
  const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
  const own = host.toLowerCase()
  if (domain === '') return false
  if (cookie.hostOnly === true) return domain === own
  return own === domain || own.endsWith(`.${domain}`)
}
