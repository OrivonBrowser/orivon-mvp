// What the Settings page may ask about the data websites keep: which sites keep any, their cookies by name
// (never by value), and removing one cookie or one site's data. A site is named by a domain this domain listed
// and a cookie by a key it minted, so a crafted message cannot reach data that was never shown.
import type { Session } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { cookiesOfDomain, cookieHost, cookieKey, viewsOf } from './cookie-list.js'
import type { CookieView } from './cookie-list.js'
import { allCookies, removeCookies } from './cookie-runner.js'
import { inventory, originsToClear } from './site-data-inventory.js'
import type { SiteSummary } from './site-data-inventory.js'

export type SiteDataSession = Pick<Session, 'cookies' | 'clearData' | 'getCacheSize' | 'storagePath'>

/** What a row needs: the same facts as the inventory, without the origins main keeps for clearing. */
export type SiteRow = Omit<SiteSummary, 'origins'>

export interface HostCookies {
  readonly host: string
  readonly cookies: readonly CookieView[]
}

const KEY = /^[0-9a-f]{16}$/

export function siteDataDomain (session: () => SiteDataSession, budgetMs = 2000): InternalDomain {
  let listed = new Map<string, SiteSummary>()

  const refresh = async (): Promise<SiteSummary[]> => {
    const current = session()
    const sites = await inventory(await allCookies(current.cookies), current.storagePath, budgetMs)
    listed = new Map(sites.map((site) => [site.domain, site]))
    return sites
  }

  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, domain?: unknown, key?: unknown }
      switch (request.type) {
        case 'list':
          return { sites: (await refresh()).map(({ origins: _origins, ...row }): SiteRow => row) }
        case 'cookies': {
          if (typeof request.domain !== 'string' || !listed.has(request.domain)) return undefined
          const own = cookiesOfDomain(await allCookies(session().cookies), request.domain)
          const hosts = new Map<string, typeof own>()
          for (const cookie of own) hosts.set(cookieHost(cookie), [...(hosts.get(cookieHost(cookie)) ?? []), cookie])
          return { hosts: [...hosts].sort(([a], [b]) => a.localeCompare(b)).map(([host, cookies]): HostCookies => ({ host, cookies: viewsOf(cookies) })) }
        }
        case 'removeCookie': {
          if (typeof request.key !== 'string' || !KEY.test(request.key) || typeof request.domain !== 'string' || !listed.has(request.domain)) return undefined
          const jar = session().cookies
          // Only among the cookies of the site that was listed, so a key computed for another site's cookie reaches nothing.
          const found = cookiesOfDomain(await allCookies(jar), request.domain).find((cookie) => cookieKey(cookie) === request.key)
          if (found === undefined) return { ok: false }
          return { ok: await removeCookies(jar, [found]) === 0 }
        }
        case 'removeSite': {
          if (typeof request.domain !== 'string') return undefined
          const known = listed.get(request.domain)
          if (known === undefined) return undefined
          const current = session()
          // The inventory is read again: what the site keeps now, not what it kept when the list was drawn.
          const now = (await inventory(await allCookies(current.cookies), current.storagePath, budgetMs)).find((site) => site.domain === known.domain) ?? known
          let failed = 0
          try {
            await current.clearData({ origins: originsToClear(now) })
          } catch (error) {
            console.error('[site-data] clearing a site failed', error)
            failed += 1
          }
          failed += await removeCookies(current.cookies, cookiesOfDomain(await allCookies(current.cookies), known.domain))
          return { ok: failed === 0 }
        }
        case 'total': {
          const current = session()
          const sites = listed.size > 0 ? [...listed.values()] : await refresh()
          let cache = 0
          try {
            cache = await current.getCacheSize()
          } catch {
            // Unknown: the total then counts site storage alone.
          }
          const measured = sites.map((site) => site.bytes).filter((bytes): bytes is number => bytes !== null)
          return { bytes: cache + measured.reduce((sum, bytes) => sum + bytes, 0) }
        }
        default:
          return undefined
      }
    }
  }
}
