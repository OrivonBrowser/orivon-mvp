// Reading and removing cookies through a session. The decisions are in ./cookie-list.ts; this is the part that
// meets Electron's cookie jar.
import type { Cookie, Session } from 'electron'
import { cookieKey, cookiesForSite, removalUrl, viewsOf } from './cookie-list.js'
import type { CookieLike, CookieView } from './cookie-list.js'

export type CookieJar = Pick<Session['cookies'], 'get' | 'remove' | 'set' | 'flushStore'>

/** Every cookie the jar holds; empty when it cannot be read, so a list never fails to open over it. */
export async function allCookies (jar: Pick<CookieJar, 'get'>): Promise<Cookie[]> {
  try {
    return await jar.get({})
  } catch {
    return []
  }
}

/** The cookies of one name that `url` reaches. */
async function allCookiesAt (jar: Pick<CookieJar, 'get'>, url: string, name: string): Promise<Cookie[]> {
  return (await jar.get({ url, name })).filter((cookie) => cookie.name === name)
}

/** Puts back a cookie that a removal by name took along with the one it was meant for. */
async function restore (jar: Pick<CookieJar, 'set'>, cookie: Cookie): Promise<void> {
  try {
    await jar.set({
      url: removalUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly === true ? {} : { domain: cookie.domain }),
      path: cookie.path ?? '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(cookie.session === true || cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      sameSite: cookie.sameSite
    })
  } catch {
    // The cookie stays gone: nothing is gained by failing the removal that was asked for.
  }
}

/**
 * Removes each cookie and writes the jar to disk. How many could not be removed. The jar removes by address and name,
 * so every cookie of that name the address reaches goes with it: the ones that were not asked for are put back.
 */
export async function removeCookies (jar: CookieJar, cookies: readonly CookieLike[]): Promise<number> {
  let failed = 0
  const asked = new Set(cookies.map(cookieKey))
  for (const cookie of cookies) {
    const url = removalUrl(cookie)
    try {
      const bystanders = (await allCookiesAt(jar, url, cookie.name)).filter((other) => !asked.has(cookieKey(other)))
      await jar.remove(url, cookie.name)
      if (bystanders.length === 0) continue
      const remaining = new Set((await allCookiesAt(jar, url, cookie.name)).map(cookieKey))
      for (const other of bystanders) if (!remaining.has(cookieKey(other))) await restore(jar, other)
    } catch {
      failed += 1
    }
  }
  try {
    await jar.flushStore()
  } catch {
    failed += 1
  }
  return failed
}

/** What a page on `host` can see, for the site-info popover. */
export async function cookieViewsFor (jar: Pick<CookieJar, 'get'>, host: string): Promise<CookieView[]> {
  return viewsOf(cookiesForSite(await allCookies(jar), host))
}

/** Removes the one cookie of the site that `key` names; false when no cookie of the site has it any more. */
export async function removeSiteCookie (jar: CookieJar, host: string, key: string): Promise<boolean> {
  const found = cookiesForSite(await allCookies(jar), host).find((cookie) => cookieKey(cookie) === key)
  if (found === undefined) return false
  await removeCookies(jar, [found])
  return true
}

export async function removeSiteCookies (jar: CookieJar, host: string): Promise<void> {
  await removeCookies(jar, cookiesForSite(await allCookies(jar), host))
}
