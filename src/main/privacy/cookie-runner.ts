// Reading and removing cookies through a session. The decisions are in ./cookie-list.ts; this is the part that
// meets Electron's cookie jar.
import type { Cookie, Session } from 'electron'
import { cookieKey, cookiesForSite, removalUrl, viewsOf } from './cookie-list.js'
import type { CookieLike, CookieView } from './cookie-list.js'

export type CookieJar = Pick<Session['cookies'], 'get' | 'remove' | 'flushStore'>

/** Every cookie the jar holds; empty when it cannot be read, so a list never fails to open over it. */
export async function allCookies (jar: Pick<CookieJar, 'get'>): Promise<Cookie[]> {
  try {
    return await jar.get({})
  } catch {
    return []
  }
}

/** Removes each cookie and writes the jar to disk. How many could not be removed. */
export async function removeCookies (jar: CookieJar, cookies: readonly CookieLike[]): Promise<number> {
  let failed = 0
  for (const cookie of cookies) {
    try {
      await jar.remove(removalUrl(cookie), cookie.name)
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
