// A cookie as the person may see it: a name, where it applies and its flags, never its value. Pure: no
// `electron` import.
import { createHash } from 'node:crypto'
import { siteOf } from './site-of.js'

/** The part of an Electron cookie this reads. */
export interface CookieLike {
  readonly name: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly session?: boolean
  readonly expirationDate?: number
}

export interface CookieView {
  /** An opaque id minted here; a page names a cookie by it and never by a URL. */
  readonly key: string
  readonly name: string
  readonly domain: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly session: boolean
  /** Seconds since the epoch, null for a session cookie. */
  readonly expires: number | null
}

const MAX_TEXT = 200
// Control characters, and the characters that reorder or hide text around them.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/** Text a hostile site chose, made safe to draw: no control or direction characters, and bounded. */
export function displayText (text: string): string {
  const clean = text.replace(UNSAFE, '?')
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean
}

/** The host a cookie's domain names, without the dot that marks a domain cookie. */
export function cookieHost (cookie: CookieLike): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
}

export function cookieKey (cookie: CookieLike): string {
  return createHash('sha256').update(`${cookie.domain ?? ''}|${cookie.path ?? '/'}|${cookie.name}`).digest('hex').slice(0, 16)
}

const siteOfHost = (host: string): string | null => siteOf(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`)

/** The cookies a page on `host` can see or set: its own host's and its parent domains', inside one registrable domain. */
export function cookiesForSite<T extends CookieLike> (all: readonly T[], host: string): T[] {
  const page = host.toLowerCase().replace(/^\[|\]$/g, '')
  const site = siteOfHost(page)
  if (site === null) return []
  return all.filter((cookie) => {
    const domain = cookieHost(cookie)
    return domain !== '' && (page === domain || page.endsWith(`.${domain}`)) && siteOfHost(domain) === site
  })
}

/** Every cookie that belongs to a registrable domain, whatever host it names. */
export function cookiesOfDomain<T extends CookieLike> (all: readonly T[], domain: string): T[] {
  return all.filter((cookie) => cookieHost(cookie) !== '' && siteOfHost(cookieHost(cookie)) === domain)
}

export function viewOf (cookie: CookieLike): CookieView {
  const session = cookie.session === true || cookie.expirationDate === undefined
  return {
    key: cookieKey(cookie),
    name: displayText(cookie.name),
    domain: displayText(cookie.domain ?? ''),
    path: displayText(cookie.path ?? '/'),
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    session,
    expires: session ? null : (cookie.expirationDate ?? null)
  }
}

const byDomainThenName = (a: CookieView, b: CookieView): number =>
  a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path)

export function viewsOf (cookies: readonly CookieLike[]): CookieView[] {
  return cookies.map(viewOf).sort(byDomainThenName)
}

/** The address that reaches this cookie when it is removed: its scheme from the Secure flag, its host and its path. */
export function removalUrl (cookie: CookieLike): string {
  const host = cookieHost(cookie)
  return `${cookie.secure === true ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}${cookie.path ?? '/'}`
}
