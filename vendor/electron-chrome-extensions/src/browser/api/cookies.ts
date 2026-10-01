import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'

enum CookieStoreID {
  Default = '0',
  Incognito = '1',
}

const onChangedCauseTranslation: { [key: string]: string } = {
  'expired-overwrite': 'expired_overwrite',
}

const createCookieDetails = (cookie: Electron.Cookie): chrome.cookies.Cookie => ({
  ...cookie,
  domain: cookie.domain || '',
  hostOnly: Boolean(cookie.hostOnly),
  session: Boolean(cookie.session),
  path: cookie.path || '',
  httpOnly: Boolean(cookie.httpOnly),
  secure: Boolean(cookie.secure),
  storeId: CookieStoreID.Default,
})

/** A URL standing in for `cookie`, for a host-permission check -- a cookie
 * itself carries no scheme, so its own `secure` flag picks http/https, the
 * same way Chrome's own cookie-permission check does. `domain` can carry a
 * leading `.` (host-only vs. domain cookies, RFC 6265): stripped, since a
 * host pattern matches a hostname, never a literal dot-prefixed one. */
const cookieUrl = (cookie: chrome.cookies.Cookie): string => {
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path}`
}

/**
 * Orivon patch: an optional predicate checked before any cookie is read or
 * written -- unset, cookies.get/getAll/set/remove and the onChanged
 * broadcast carry every cookie of the session to every extension holding
 * the `cookies` permission, regardless of its OWN host permissions. Set
 * once, before the first cookies call (extension-host.ts); `manifest` is
 * `event.extension.manifest`, the loaded extension's own manifest.
 */
// Orivon patch (UPSTREAM.md patch 47): the third argument is the calling
// extension's id, so a host decision can use more than its manifest.
type CookieHostAccessCheck = (manifest: unknown, url: string, extensionId: string) => boolean
let gCookieHostAccessCheck: CookieHostAccessCheck | undefined

export function setCookieHostAccessCheck(check: CookieHostAccessCheck): void {
  gCookieHostAccessCheck = check
}

function hasHostAccess(event: ExtensionEvent, url: string): boolean {
  return !gCookieHostAccessCheck || gCookieHostAccessCheck(event.extension.manifest, url, event.extension.id)
}

export class CookiesAPI {
  private get cookies() {
    return this.ctx.session.cookies
  }

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    // Orivon patch: every handler here now declares `permission: 'cookies'`
    // -- router.ts's own onExtensionMessage already refuses a call from an
    // extension whose manifest lacks it, the same mechanism every other
    // permission-gated API in this library uses. Host-permission matching
    // (per this file's own doc above) is a SECOND, narrower check this
    // permission option cannot express on its own.
    handle('cookies.get', this.get.bind(this), { permission: 'cookies' })
    handle('cookies.getAll', this.getAll.bind(this), { permission: 'cookies' })
    handle('cookies.set', this.set.bind(this), { permission: 'cookies' })
    handle('cookies.remove', this.remove.bind(this), { permission: 'cookies' })
    handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this), { permission: 'cookies' })

    this.cookies.addListener('changed', this.onChanged)
  }

  private async get(
    event: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    if (!hasHostAccess(event, details.url)) {
      throw new Error(`cookies.get requires host access to ${details.url}`)
    }

    // TODO: storeId
    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
    })

    // TODO: If more than one cookie of the same name exists for the given URL,
    // the one with the longest path will be returned. For cookies with the
    // same path length, the cookie with the earliest creation time will be returned.
    const [first] = cookies
    return first !== undefined ? createCookieDetails(first) : null
  }

  private async getAll(
    event: ExtensionEvent,
    details: chrome.cookies.GetAllDetails,
  ): Promise<chrome.cookies.Cookie[]> {
    // TODO: storeId
    // Built with only the keys actually present -- exactOptionalPropertyTypes
    // treats an explicit `url: undefined` as different from no `url` key at
    // all, and GetAllDetails' own fields are all optional.
    const filter: Electron.CookiesGetFilter = {
      ...(details.url === undefined ? {} : { url: details.url }),
      ...(details.name === undefined ? {} : { name: details.name }),
      ...(details.domain === undefined ? {} : { domain: details.domain }),
      ...(details.path === undefined ? {} : { path: details.path }),
      ...(details.secure === undefined ? {} : { secure: details.secure }),
      ...(details.session === undefined ? {} : { session: details.session }),
    }
    const cookies = await this.cookies.get(filter)

    // Filtered, not refused: Chrome's own cookies.getAll drops a matching
    // cookie the caller has no host permission for instead of erroring the
    // whole call (this file's own doc on cookieUrl says how a cookie's own
    // URL is derived for the check).
    return cookies.map(createCookieDetails).filter((cookie) => hasHostAccess(event, cookieUrl(cookie)))
  }

  private async set(
    event: ExtensionEvent,
    details: chrome.cookies.SetDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    if (!hasHostAccess(event, details.url)) {
      throw new Error(`cookies.set requires host access to ${details.url}`)
    }

    // Chrome's own SetDetails leaves most fields optional; Electron's own
    // CookiesSetDetails/CookiesGetFilter types require a couple of them --
    // the cast is type-level only, the object forwarded is unchanged.
    await this.cookies.set(details as Electron.CookiesSetDetails)
    const cookies = await this.cookies.get(details as Electron.CookiesGetFilter)
    const [first] = cookies
    return first !== undefined ? createCookieDetails(first) : null
  }

  private async remove(
    event: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.CookieDetails | null> {
    if (!hasHostAccess(event, details.url)) {
      throw new Error(`cookies.remove requires host access to ${details.url}`)
    }

    try {
      await this.cookies.remove(details.url, details.name)
    } catch {
      return null
    }
    return details
  }

  private async getAllCookieStores(event: ExtensionEvent): Promise<chrome.cookies.CookieStore[]> {
    const tabIds = Array.from(this.ctx.store.tabs)
      .map((tab) => (tab.isDestroyed() ? undefined : tab.id))
      .filter(Boolean) as number[]
    return [{ id: CookieStoreID.Default, tabIds }]
  }

  private onChanged = (
    event: Electron.Event,
    cookie: Electron.Cookie,
    cause: string,
    removed: boolean,
  ) => {
    const changeInfo: chrome.cookies.CookieChangeInfo = {
      cause: onChangedCauseTranslation[cause] || cause,
      cookie: createCookieDetails(cookie),
      removed,
    }

    // Per-listener gating (the `cookies` permission and this cookie's own
    // host access) happens in router.ts's sendEvent, through the filter
    // extension-host.ts installs with setEventListenerFilter -- this
    // broadcast itself stays unconditional, the same as every other event
    // in this library.
    this.ctx.router.broadcastEvent('cookies.onChanged', changeInfo)
  }
}
