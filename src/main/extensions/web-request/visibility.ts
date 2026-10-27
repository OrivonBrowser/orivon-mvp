// Which requests an extension's `webRequest` listeners may see: Chrome's
// rules, in Orivon's terms. The host-access question is answered by the
// caller (`hasHostAccess`), so this file knows no manifest and no registry.
import { isShellSchemeUrl } from '../../shell/shell-session.js'
import type { WebRequestEventName } from './filter.js'

export interface VisibleRequest {
  readonly event: WebRequestEventName
  readonly url: string
  /** Orivon's own main-process requests (the verifier, `net.fetch`) have no
   * page behind them and are never shown to an extension. */
  readonly fromPage: boolean
  readonly type: string
  /** The origin of the document that made the request; absent for a
   * top-level navigation and for an opaque origin. */
  readonly initiator?: string | undefined
  /** The URL of the page that made the request, when it was a page. */
  readonly pageUrl?: string | undefined
}

/** A page of the shell's own (`orivon-shell:` for its renderer entries, `orivon:` for its internal pages): no
 * extension's request rules or listeners ever apply to it, or to what it loads. */
export function isShellOwnUrl (url: string): boolean {
  return url.startsWith('orivon:') || isShellSchemeUrl(url)
}

const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** The web store: no extension sees its pages or anything they load,
 * since a listing or a script there could otherwise be rewritten to hide
 * what an extension is. */
function isProtectedUrl (url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'chromewebstore.google.com') return true
  return url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')
}

/** Whether `url` is on the web store, for the request rules that do not go through `requestVisibleTo`. */
export function isWebStoreUrl (url: string): boolean {
  const parsed = parse(url)
  return parsed !== undefined && isProtectedUrl(parsed)
}

const NAVIGATION_TYPES = new Set(['main_frame', 'sub_frame'])

function parse (url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/** The URL a host permission is asked about: a WebSocket is covered by the
 * host access of the HTTP origin it shares. */
function accessUrlOf (url: URL): string {
  if (url.protocol === 'ws:') return `http:${url.href.slice('ws:'.length)}`
  if (url.protocol === 'wss:') return `https:${url.href.slice('wss:'.length)}`
  return url.href
}

/**
 * A name Orivon's own protocols serve is loaded, and failed, by Orivon: the error of a navigation to one is never shown to an
 * extension, since the one that hears it can take the tab to a gateway or a page of its own. The name's other events stay visible.
 * `servesHost` answers for a host a protocol serves, whatever the scheme it is reached by.
 */
function isServedNavigationError (request: VisibleRequest, url: URL, servesHost: (hostname: string) => boolean): boolean {
  return request.event === 'onErrorOccurred' && NAVIGATION_TYPES.has(request.type) && (url.protocol === 'http:' || url.protocol === 'https:') && servesHost(url.hostname)
}

function initiatorHidden (initiator: URL, extensionId: string): boolean {
  if (initiator.protocol === 'orivon:' || initiator.protocol === 'orivon-shell:' || initiator.protocol === 'chrome:' || initiator.protocol === 'devtools:') return true
  return initiator.protocol === 'chrome-extension:' && initiator.hostname !== extensionId
}

/**
 * `isAppOrigin` answers for a registered app's origin: a request whose URL, initiator or page is one is hidden from every extension.
 * `servesHost` answers for a host Orivon's protocols serve: the error of a navigation to one is hidden from every extension.
 */
export function requestVisibleTo (
  extensionId: string,
  request: VisibleRequest,
  hasHostAccess: (url: string) => boolean,
  isAppOrigin: (url: string) => boolean = () => false,
  servesHost: (hostname: string) => boolean = () => false
): boolean {
  if (!request.fromPage) return false
  if ([request.url, request.initiator, request.pageUrl].some((url) => url !== undefined && isAppOrigin(url))) return false
  const url = parse(request.url)
  if (url === undefined) return false
  const initiator = request.initiator === undefined ? undefined : parse(request.initiator)
  const page = request.pageUrl === undefined ? undefined : parse(request.pageUrl)
  if ([url, initiator, page].some((each) => each !== undefined && isProtectedUrl(each))) return false
  if (isServedNavigationError(request, url, servesHost)) return false
  const ownUrl = url.protocol === 'chrome-extension:' && url.hostname === extensionId
  if (!ownUrl && !WEB_SCHEMES.has(url.protocol)) return false
  if (initiator !== undefined && initiatorHidden(initiator, extensionId)) return false
  if (!ownUrl && !hasHostAccess(accessUrlOf(url))) return false
  if (initiator === undefined || NAVIGATION_TYPES.has(request.type)) return true
  if (initiator.protocol === 'chrome-extension:') return true
  return hasHostAccess(accessUrlOf(initiator))
}
