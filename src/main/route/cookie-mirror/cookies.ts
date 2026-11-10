// A cookie as one session holds it, which site it belongs to, and how it is written into another with every attribute it had. Pure.

import { mirrorSiteOf } from './mirror-site.js'

export type SameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

/** The part of Electron's `Cookie` the mirror reads. */
export interface StoredCookie {
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly hostOnly?: boolean
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly session?: boolean
  readonly expirationDate?: number
  readonly sameSite?: SameSite
}

/** The part of Electron's `CookiesSetDetails` the mirror writes. */
export interface CookieToSet {
  readonly url: string
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly expirationDate?: number
  readonly sameSite: SameSite
}

export type ChangeCause = 'inserted' | 'inserted-no-change-overwrite' | 'inserted-no-value-change-overwrite' | 'explicit' | 'overwrite' | 'expired' | 'evicted' | 'expired-overwrite'

/** What the mirror asks of one session's cookies: Electron's `session.cookies`, or a fake. */
export interface CookieStore {
  /**
   * Every cookie of the given sites (registrable domains): those whose domain is a site or below it. A read of the whole jar in
   * Electron, whose `domain` filter is applied after the jar is read, so it is asked once for all the sites a step needs and never
   * once for each cookie.
   */
  readonly list: (sites: readonly string[]) => Promise<StoredCookie[]>
  /** The cookies named `name` that a request to `address` would send. Scoped by address, so cheap: the read to use for one cookie. */
  readonly find: (address: string, name: string) => Promise<StoredCookie[]>
  readonly set: (details: CookieToSet) => Promise<void>
  /** Removes the cookies of `name` that `url` would send: the host's own and the ones of its parent domains. */
  readonly remove: (url: string, name: string) => Promise<void>
  /** Calls `listener` for each change in this store, from now on; returns the way to stop. */
  readonly watch: (listener: (cookie: StoredCookie, cause: ChangeCause, removed: boolean) => void) => () => void
  readonly flush: () => Promise<void>
}

export type SetPlan = { readonly kind: 'set', readonly cookie: CookieToSet } | { readonly kind: 'skip', readonly reason: 'expired' | 'no domain' }

/** An expiry read back from a store can differ from the one written by a rounding. */
const EXPIRY_TOLERANCE_SECONDS = 1.5

const hostOf = (cookie: Pick<StoredCookie, 'domain'>): string => (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
const isSession = (cookie: StoredCookie): boolean => cookie.session === true || cookie.expirationDate === undefined

/** Name, domain and path tell a cookie apart; a host-only cookie and a domain cookie of one host are two. */
export function identityOf (cookie: StoredCookie): string {
  return [cookie.name, hostOf(cookie), cookie.hostOnly === true ? 'host' : 'domain', cookie.path ?? '/'].join('\u0000')
}

/** The site a cookie belongs to (`mirror-site.ts`): `shop.example` for a cookie of `.www.shop.example`; undefined for a cookie with no domain. */
export function siteOfCookie (cookie: Pick<StoredCookie, 'domain'>): string | undefined {
  const host = hostOf(cookie)
  if (host === '') return undefined
  return mirrorSiteOf(`https://${host.includes(':') ? `[${host}]` : host}/`)
}

/** The address a cookie is sent to, with which `remove` takes it; undefined for a cookie with no domain. */
export function addressOf (cookie: StoredCookie): string | undefined {
  const host = hostOf(cookie)
  if (host === '') return undefined
  const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path
  // A `?` or `#` in the path would end the address's path there.
  return `https://${host.includes(':') ? `[${host}]` : host}${path.replace(/\?/g, '%3F').replace(/#/g, '%23')}`
}

/** Whether `cookie` is one a request to `address` would send: what `remove(address, name)` takes along with the cookie it was asked for. */
export function wouldSend (cookie: StoredCookie, address: string): boolean {
  let url: URL
  try { url = new URL(address) } catch { return false }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const domain = hostOf(cookie)
  if (domain === '' || !(cookie.hostOnly === true ? host === domain : host === domain || host.endsWith(`.${domain}`))) return false
  const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path
  const pathMatches = url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname.charAt(path.length) === '/'))
  return pathMatches && (cookie.secure !== true || url.protocol === 'https:')
}

/**
 * How to write `cookie` into another session. A host-only cookie is written with no domain, so it stays host-only; a
 * session cookie with no expiry, so it stays one. A cookie that has expired is not carried.
 */
export function planSet (cookie: StoredCookie, nowSeconds: number): SetPlan {
  const address = addressOf(cookie)
  if (address === undefined) return { kind: 'skip', reason: 'no domain' }
  if (!isSession(cookie) && (cookie.expirationDate as number) <= nowSeconds) return { kind: 'skip', reason: 'expired' }
  return {
    kind: 'set',
    cookie: {
      url: address,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly === true ? {} : { domain: `.${hostOf(cookie)}` }),
      path: cookie.path === undefined || cookie.path === '' ? '/' : cookie.path,
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(isSession(cookie) ? {} : { expirationDate: cookie.expirationDate as number }),
      sameSite: cookie.sameSite ?? 'unspecified'
    }
  }
}

/** Whether two cookies of one identity hold the same value and attributes. */
export function sameCookie (left: StoredCookie, right: StoredCookie): boolean {
  if (left.value !== right.value || (left.secure === true) !== (right.secure === true) || (left.httpOnly === true) !== (right.httpOnly === true)) return false
  if ((left.sameSite ?? 'unspecified') !== (right.sameSite ?? 'unspecified') || isSession(left) !== isSession(right)) return false
  return isSession(left) || Math.abs((left.expirationDate as number) - (right.expirationDate as number)) < EXPIRY_TOLERANCE_SECONDS
}

/**
 * Whether a change is one to carry to the other sessions. An overwrite is announced as a removal and then an insert, so the
 * removal is not followed; a site deletes a cookie by sending it already expired (`expired-overwrite`), which is followed. A
 * cookie that ran out or was evicted goes from each session by itself, and an insert that changed nothing has nothing to carry.
 */
export function followsChange (cause: ChangeCause, removed: boolean): boolean {
  if (removed) return cause === 'explicit' || cause === 'expired-overwrite'
  return cause !== 'inserted-no-change-overwrite'
}
