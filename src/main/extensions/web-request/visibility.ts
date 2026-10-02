// Which requests an extension's `webRequest` listeners may see: Chrome's
// rules, in Orivon's terms. The host-access question is answered by the
// caller (`hasHostAccess`), so this file knows no manifest and no registry.

export interface VisibleRequest {
  readonly url: string
  /** Orivon's own main-process requests (the verifier, `net.fetch`) have no
   * page behind them and are never shown to an extension. */
  readonly fromPage: boolean
  readonly type: string
  /** The origin of the document that made the request; absent for a
   * top-level navigation and for an opaque origin. */
  readonly initiator?: string | undefined
}

const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** Pages no extension may observe: the web store, whose listings an
 * extension could otherwise rewrite to hide what it is. */
function isProtectedUrl (url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'chromewebstore.google.com') return true
  return url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')
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

function initiatorHidden (initiator: URL, extensionId: string): boolean {
  if (initiator.protocol === 'orivon:' || initiator.protocol === 'chrome:' || initiator.protocol === 'devtools:') return true
  return initiator.protocol === 'chrome-extension:' && initiator.hostname !== extensionId
}

export function requestVisibleTo (extensionId: string, request: VisibleRequest, hasHostAccess: (url: string) => boolean): boolean {
  if (!request.fromPage) return false
  const url = parse(request.url)
  if (url === undefined || isProtectedUrl(url)) return false
  const ownUrl = url.protocol === 'chrome-extension:' && url.hostname === extensionId
  if (!ownUrl && !WEB_SCHEMES.has(url.protocol)) return false
  const initiator = request.initiator === undefined ? undefined : parse(request.initiator)
  if (initiator !== undefined && initiatorHidden(initiator, extensionId)) return false
  if (!ownUrl && !hasHostAccess(accessUrlOf(url))) return false
  if (initiator === undefined || NAVIGATION_TYPES.has(request.type)) return true
  if (initiator.protocol === 'chrome-extension:') return true
  return hasHostAccess(accessUrlOf(initiator))
}
