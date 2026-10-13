// Orivon's own requests (self-update, telemetry, bug reports, omnibox suggestions, an app's manifest, the loader's
// bundle): while the whole browser is on the tunnel each goes through it or does not happen. `net.fetch` and the global
// `fetch` cannot sign in to the tunnel's front, so a request of this kind is made with `net.request` in the default
// session, answering the front's challenge itself. For a website the person set to off it goes out on the system's proxy
// instead, as that website does. Main supplies the pieces once; with the browser-wide setting off, or before they are
// supplied, the caller's own `fetch` is used as it always was.

export type OwnFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface OwnRequests {
  /** Whether the whole browser is on the tunnel now. */
  readonly everywhere: () => boolean
  /** Whether the traffic of the website or app at `origin` goes through the tunnel. */
  readonly isRouted: (origin: string) => boolean
  /** A request made in the default session, which then is the tunnel's, answering its front. */
  readonly tunnel: OwnFetch
  /** A request made in a session that follows the system's proxy, for an origin set to off. */
  readonly direct: OwnFetch
  /** That session, for a caller that makes its own requests with `net.request`. */
  readonly directSession: () => object
  /**
   * With the browser-wide setting off, the session a request about the website at `origin` is made in when the website has its
   * tunnel on: the tunnel profile's, which signs in to its front. Undefined for any other origin, whose request is the caller's own.
   * Rejects when the website is routed and its route cannot be had, and the request is then not made.
   */
  readonly siteSession?: (origin: string) => Promise<object | undefined>
  /** `siteSession` as a `fetch`, for a caller that makes its request with one. */
  readonly through?: (origin: string) => Promise<OwnFetch | undefined>
  /** Resolves when every session follows the browser-wide setting as it stands now. */
  readonly settled?: () => Promise<void>
  /** How long a request waits for that before it is refused; for a test. */
  readonly settleMs?: number
}

let source: OwnRequests | undefined
const SETTLE_MS = 15_000

/**
 * Waits for the sessions to follow the browser-wide setting, in either direction, and refuses when they do not within a bounded
 * time: a request made while the default session is still direct (switching on) or still on the tunnel's front (switching off)
 * would leave the wrong way.
 */
async function sessionsFollowSetting (current: OwnRequests): Promise<void> {
  if (current.settled === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('the tunnel setting is still being applied')) }, current.settleMs ?? SETTLE_MS) })
  try {
    await Promise.race([current.settled(), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Called once at start by whoever owns the routes. */
export function setOwnRequests (next: OwnRequests | undefined): void {
  source = next
}

/** For a caller that decides how to leave itself: resolves once every session follows the browser-wide setting as it stands, and rejects when that takes too long. Nothing to wait for before routes run. */
export async function ownRequestsSettled (): Promise<void> {
  if (source !== undefined) await sessionsFollowSetting(source)
}

/** Whether Orivon's own requests must go through the tunnel now. */
export function ownRequestsTunnelled (): boolean {
  return source?.everywhere() === true
}

/**
 * How a request of Orivon's own about `origin` (a website or app, if any) leaves now: `ordinary` while the browser-wide setting is
 * off, `tunnel` through the default session (the tunnel's), `direct` through a session on the system's proxy for an origin
 * set to off.
 */
export function ownRouteFor (origin?: string): 'ordinary' | 'tunnel' | 'direct' {
  const current = source
  if (current === undefined || !current.everywhere()) return 'ordinary'
  return origin !== undefined && !current.isRouted(origin) ? 'direct' : 'tunnel'
}

/** The session a `direct` request is made in, or undefined while the browser-wide setting is off. */
export function ownDirectSession (): object | undefined {
  return source?.everywhere() === true ? source.directSession() : undefined
}

/** The session a request of Orivon's own about the website at `origin` is made in while the browser-wide setting is off, if the website has its tunnel on. */
export async function ownSiteSession (origin: string): Promise<object | undefined> {
  const current = source
  if (current === undefined || current.everywhere()) return undefined
  return await current.siteSession?.(origin)
}

/**
 * `ordinary`, unless the whole browser is on the tunnel, when the request goes through it. `origin` is the website or app
 * the request is about, if any: one the person set to off is asked for directly, and one that is routed on its own (a tunnel
 * profile's website, a routed app) is asked for through its route even while the browser-wide setting is off, since the
 * request would otherwise show the person's address to a site they only open through the tunnel.
 */
export function ownFetch (ordinary: OwnFetch, origin?: string): OwnFetch {
  return async (url, init) => {
    if (source !== undefined) await sessionsFollowSetting(source)
    const current = source
    if (current === undefined) return await ordinary(url, init)
    if (!current.everywhere()) {
      const routed = origin === undefined ? undefined : await current.through?.(origin)
      return await (routed ?? ordinary)(url, init)
    }
    if (origin !== undefined && !current.isRouted(origin)) return await current.direct(url, init)
    return await current.tunnel(url, init)
  }
}
