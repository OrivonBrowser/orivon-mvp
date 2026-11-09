import { identityOf } from '../cookies.js'
import type { ChangeCause, CookieStore, CookieToSet, StoredCookie } from '../cookies.js'

type Listener = (cookie: StoredCookie, cause: ChangeCause, removed: boolean) => void

/**
 * A cookie store that behaves as Chromium's does where the mirror depends on it: a cookie is told apart by name, domain and path
 * (a host-only cookie and a domain cookie of one host are two); an overwrite is announced as a removal and then an insert; a write that
 * changes nothing is announced as `inserted-no-change-overwrite`; `remove(url, name)` takes every cookie of that name the address
 * would send; every announcement arrives after the call that caused it has returned. It counts each write so a test can say how
 * many there were.
 */
export class FakeCookieStore implements CookieStore {
  readonly cookies = new Map<string, StoredCookie>()
  readonly writes: Array<{ readonly kind: 'set' | 'remove', readonly name: string }> = []
  private readonly listeners = new Set<Listener>()
  /** A store that stores every value changed, so a mirror that trusts it would write for ever. */
  corrupts = false
  /** Rejects the next `set` with the message. */
  failNextSet: string | undefined

  constructor (readonly label: string) {}

  list (): StoredCookie[] {
    return [...this.cookies.values()]
  }

  get (name: string, domain?: string): StoredCookie | undefined {
    return this.list().find((cookie) => cookie.name === name && (domain === undefined || cookie.domain === domain))
  }

  private announce (cookie: StoredCookie, cause: ChangeCause, removed: boolean): void {
    queueMicrotask(() => { for (const listener of [...this.listeners]) listener(cookie, cause, removed) })
  }

  private put (cookie: StoredCookie): void {
    const key = identityOf(cookie)
    const before = this.cookies.get(key)
    this.cookies.set(key, cookie)
    if (before === undefined) { this.announce(cookie, 'inserted', false); return }
    const same = JSON.stringify(before) === JSON.stringify(cookie)
    if (same) { this.announce(cookie, 'inserted-no-change-overwrite', false); return }
    this.announce(before, 'overwrite', true)
    this.announce(cookie, before.value === cookie.value ? 'inserted-no-value-change-overwrite' : 'inserted', false)
  }

  /** Puts a cookie in the store as it was before the test, announcing nothing. */
  seed (cookie: StoredCookie): void {
    this.cookies.set(identityOf(cookie), cookie)
  }

  /** What the site does: a cookie set by a response or a script. */
  siteSets (cookie: StoredCookie): void {
    this.put(cookie)
  }

  /** What the site does to log out: a cookie sent already expired takes the held one away. */
  siteExpires (name: string, domain: string): void {
    const found = this.list().find((cookie) => cookie.name === name && cookie.domain === domain)
    if (found === undefined) return
    this.cookies.delete(identityOf(found))
    this.announce(found, 'expired-overwrite', true)
  }

  /** What Chromium does with a cookie that ran out, or that the store had too many of: no site and no person asked. */
  lapses (name: string, domain: string, cause: 'expired' | 'evicted'): void {
    const found = this.list().find((cookie) => cookie.name === name && cookie.domain === domain)
    if (found === undefined) return
    this.cookies.delete(identityOf(found))
    this.announce(found, cause, true)
  }

  async all (): Promise<StoredCookie[]> {
    return this.list()
  }

  async find (name: string, domain?: string): Promise<StoredCookie[]> {
    const wanted = domain?.replace(/^\./, '')
    return this.list().filter((cookie) => cookie.name === name && (wanted === undefined || (cookie.domain ?? '').replace(/^\./, '') === wanted))
  }

  async set (details: CookieToSet): Promise<void> {
    this.writes.push({ kind: 'set', name: details.name })
    if (this.failNextSet !== undefined) { const message = this.failNextSet; this.failNextSet = undefined; throw new Error(message) }
    const host = new URL(details.url).hostname
    const hostOnly = details.domain === undefined
    this.put({
      name: details.name,
      value: this.corrupts ? `${details.value}+` : details.value,
      domain: hostOnly ? host : (details.domain?.startsWith('.') === true ? details.domain : `.${details.domain ?? host}`),
      hostOnly,
      path: details.path,
      secure: details.secure,
      httpOnly: details.httpOnly,
      session: details.expirationDate === undefined,
      ...(details.expirationDate === undefined ? {} : { expirationDate: details.expirationDate }),
      sameSite: details.sameSite
    })
  }

  async remove (url: string, name: string): Promise<void> {
    this.writes.push({ kind: 'remove', name })
    const address = new URL(url)
    for (const cookie of this.list()) {
      const domain = (cookie.domain ?? '').replace(/^\./, '')
      const domainMatches = cookie.hostOnly === true ? address.hostname === domain : address.hostname === domain || address.hostname.endsWith(`.${domain}`)
      if (cookie.name !== name || !domainMatches || !address.pathname.startsWith(cookie.path ?? '/') || (cookie.secure === true && address.protocol !== 'https:')) continue
      this.cookies.delete(identityOf(cookie))
      this.announce(cookie, 'explicit', true)
    }
  }

  watch (listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async clear (): Promise<void> {
    this.cookies.clear()
  }

  async flush (): Promise<void> {}

  get listening (): number {
    return this.listeners.size
  }
}

export const WEEK = 7 * 24 * 3600

/** A persistent cookie of the kind a sign-in sets. */
export function signIn (over: Partial<StoredCookie> = {}): StoredCookie {
  return { name: 'sid', value: 'one', domain: 'example.com', hostOnly: true, path: '/', secure: true, httpOnly: true, session: false, expirationDate: 4_000_000_000, sameSite: 'lax', ...over }
}
