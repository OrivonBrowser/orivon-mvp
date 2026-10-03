// Which sites keep data in a session, found without any per-origin API (Electron has none): the cookie jar
// names the hosts with cookies, and the per-origin folders under the session's storage path name the origins
// that wrote IndexedDB. Local storage and service workers live in databases that are not split by origin, so
// a site that only uses those is not listed (README.md's Design notes).
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cookieHost, cookiesOfDomain } from './cookie-list.js'
import type { CookieLike } from './cookie-list.js'
import { siteOf } from './site-of.js'

export interface SiteSummary {
  /** The registrable domain, or the host itself for an address with none. */
  readonly domain: string
  /** Every host under the domain with cookies or storage, sorted. */
  readonly hosts: readonly string[]
  readonly cookies: number
  /** The storage kinds found on disk, by the name a person reads. */
  readonly kinds: readonly string[]
  /** What the measurable storage takes on disk; null when nothing could be measured. */
  readonly bytes: number | null
  /** Origins found on disk, with their ports: what a clear must name besides the default-port ones. */
  readonly origins: readonly string[]
}

/** A moment after which a walk stops and reports nothing rather than hold the page up. */
interface Budget { readonly expired: () => boolean }

/** Bytes under `path`; null when the budget ran out first. A folder that cannot be read counts as empty. */
export async function folderBytes (path: string, budget: Budget): Promise<number | null> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (budget.expired()) return null
    const full = join(path, entry.name)
    if (entry.isDirectory()) {
      const inner = await folderBytes(full, budget)
      if (inner === null) return null
      total += inner
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size
      } catch {
        // Gone between the listing and the size: it counts for nothing.
      }
    }
  }
  return total
}

interface DiskOrigin {
  readonly origin: string
  readonly host: string
  readonly bytes: number | null
}

const INDEXED_DB = /^(https?)_(.+)_(\d+)\.indexeddb\.(?:leveldb|blob)$/

/** `http_127.0.0.1_8080.indexeddb.leveldb` names the origin `http://127.0.0.1:8080`. */
export function originOfFolder (name: string): string | null {
  const match = INDEXED_DB.exec(name)
  if (match === null) return null
  const host = (match[2] as string).replace(/^\[|\]$/g, '')
  try {
    return new URL(`${match[1] as string}://${host.includes(':') ? `[${host}]` : host}:${match[3] as string}`).origin
  } catch {
    return null
  }
}

async function scanIndexedDb (storagePath: string, budget: Budget): Promise<DiskOrigin[]> {
  let names: string[]
  try {
    names = await readdir(join(storagePath, 'IndexedDB'))
  } catch {
    return []
  }
  const sizes = new Map<string, number | null>()
  for (const name of names) {
    const origin = originOfFolder(name)
    if (origin === null) continue
    const size = await folderBytes(join(storagePath, 'IndexedDB', name), budget)
    const before = sizes.get(origin)
    sizes.set(origin, size === null || before === null ? null : (before ?? 0) + size)
  }
  return [...sizes].map(([origin, bytes]) => ({ origin, host: new URL(origin).hostname.replace(/^\[|\]$/g, ''), bytes }))
}

const byName = (a: string, b: string): number => a.localeCompare(b)

export async function inventory (
  cookies: readonly CookieLike[],
  storagePath: string | null,
  budgetMs = 2000,
  now: () => number = Date.now
): Promise<SiteSummary[]> {
  const deadline = now() + budgetMs
  const disk = storagePath === null ? [] : await scanIndexedDb(storagePath, { expired: () => now() > deadline })
  const domains = new Set<string>()
  for (const cookie of cookies) {
    const site = siteOf(`http://${cookieHost(cookie)}/`)
    if (cookieHost(cookie) !== '' && site !== null) domains.add(site)
  }
  for (const found of disk) {
    const site = siteOf(found.origin)
    if (site !== null) domains.add(site)
  }

  return [...domains].sort(byName).map((domain) => {
    const own = cookiesOfDomain(cookies, domain)
    const stored = disk.filter((found) => siteOf(found.origin) === domain)
    const hosts = new Set([...own.map(cookieHost), ...stored.map((found) => found.host)])
    const measured = stored.length > 0 && stored.every((found) => found.bytes !== null)
    return {
      domain,
      hosts: [...hosts].sort(byName),
      cookies: own.length,
      kinds: stored.length > 0 ? ['IndexedDB'] : [],
      bytes: measured ? stored.reduce((sum, found) => sum + (found.bytes ?? 0), 0) : null,
      origins: stored.map((found) => found.origin)
    }
  })
}

const isIpLiteral = (host: string | undefined): boolean => host !== undefined && (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host))

/** Everything a clear for `site` must name: its disk origins, and both schemes of every host (cookie-only hosts have no
 * port to read). A site whose cookies all sit on its domain says nothing of the host it runs on, so the domain and its
 * `www.` host are named too: storage is cleared by exact origin. */
export function originsToClear (site: Pick<SiteSummary, 'hosts' | 'origins'> & { readonly domain?: string }): string[] {
  const out = new Set(site.origins)
  const named = isIpLiteral(site.domain) || site.domain === undefined ? [] : [site.domain, `www.${site.domain}`]
  for (const host of new Set([...site.hosts, ...named])) {
    const printable = host.includes(':') ? `[${host}]` : host
    out.add(`http://${printable}`)
    out.add(`https://${printable}`)
  }
  return [...out]
}
