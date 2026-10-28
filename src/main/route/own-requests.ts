// Orivon's own requests (self-update, telemetry, bug reports, omnibox suggestions, an app's manifest, the loader's
// bundle): while the whole browser is on the tunnel each goes through it or does not happen. `net.fetch` and the global
// `fetch` cannot sign in to the tunnel's front, so a request of this kind is made with `net.request` in the default
// session, answering the front's challenge itself. For a website the person set to off it goes out on the system's proxy
// instead, as that website does. Main supplies the pieces once; with the browser-wide setting off, or before they are
// supplied, the caller's own `fetch` is used as it always was.

import type { RouteEndpoint } from '../../protocols/local-node/protocol.js'
import type { TunnelKind } from './route-state.js'

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
   * Whether the website at `origin` has a tunnel of its own, so that a request about it is made in that tunnel's profile session
   * (`siteSession`) whatever the browser-wide setting says, and the far end of that tunnel resolves its name.
   */
  readonly siteTunnelled?: (origin: string) => boolean
  /**
   * The session a request about the website at `origin` is made in when the website has a tunnel of its own, whatever the
   * browser-wide setting says: that tunnel's profile session, which signs in to its front. Undefined for any other origin, whose
   * request is the caller's own or the default tunnel's. Rejects when the website is routed and its route cannot be had, and the
   * request is then not made.
   */
  readonly siteSession?: (origin: string) => Promise<object | undefined>
  /** `siteSession` as a `fetch`, for a caller that makes its request with one. */
  readonly through?: (origin: string) => Promise<OwnFetch | undefined>
  /** A `fetch` made in the profile session of `kind`, which signs in to its front: for a request made on behalf of a tab with a tunnel choice that is about no origin. */
  readonly profileFetch?: (kind: TunnelKind) => OwnFetch
  /**
   * Where a local node's traffic leaves while the whole browser is on the tunnel: the tunnel's SOCKS5 address and the sign-in for the
   * node named `key`, starting the tunnel if need be. Rejects, in words, when the tunnel cannot carry it. Absent before routes run.
   */
  readonly nodeEndpoint?: (key: string) => Promise<RouteEndpoint>
  /** Called when an address `nodeEndpoint` handed out is no longer the tunnel's (its process restarted on another port, or stopped). Returns the unsubscribe. */
  readonly onNodeRouteMoved?: (listener: () => void) => () => void
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

const movedListeners = new Set<() => void>()
let stopWatchingMoves: (() => void) | undefined

/** Called once at start by whoever owns the routes. */
export function setOwnRequests (next: OwnRequests | undefined): void {
  source = next
  stopWatchingMoves?.()
  stopWatchingMoves = next?.onNodeRouteMoved?.(() => { for (const listener of [...movedListeners]) listener() })
}

/** For a caller that decides how to leave itself: resolves once every session follows the browser-wide setting as it stands, and rejects when that takes too long. Nothing to wait for before routes run. */
export async function ownRequestsSettled (): Promise<void> {
  if (source !== undefined) await sessionsFollowSetting(source)
}

/** Whether Orivon's own requests must go through the tunnel now. */
export function ownRequestsTunnelled (): boolean {
  return source?.everywhere() === true
}

/** Where the local node `key` reaches the network while the whole browser is on the tunnel; rejects when it cannot, and when no routes run. */
export async function ownNodeEndpoint (key: string): Promise<RouteEndpoint> {
  if (source?.nodeEndpoint === undefined) throw new Error('the tunnel is not available yet')
  return await source.nodeEndpoint(key)
}

/** A listener for the moment the tunnel's address a node was given stops being right; it hears nothing until routes run. */
export function onOwnNodeRouteMoved (listener: () => void): () => void {
  movedListeners.add(listener)
  return () => { movedListeners.delete(listener) }
}

/**
 * How a request of Orivon's own about `origin` (a website or app, if any) leaves now: `ordinary` while the browser-wide setting is
 * off, `tunnel` through the default session (the tunnel's), `direct` through a session on the system's proxy for an origin
 * set to off.
 */
export function ownRouteFor (origin?: string): 'ordinary' | 'tunnel' | 'direct' {
  const current = source
  // A website with a tunnel of its own is asked about in that tunnel, with the browser-wide setting off too: its name is resolved at the far end.
  if (current !== undefined && origin !== undefined && current.siteTunnelled?.(origin) === true) return 'tunnel'
  if (current === undefined || !current.everywhere()) return 'ordinary'
  return origin !== undefined && !current.isRouted(origin) ? 'direct' : 'tunnel'
}

/** The session a `direct` request is made in, or undefined while the browser-wide setting is off. */
export function ownDirectSession (): object | undefined {
  return source?.everywhere() === true ? source.directSession() : undefined
}

/** The session a request of Orivon's own about the website at `origin` is made in, if the website has a tunnel of its own: whatever the browser-wide setting says, so that it never leaves through the default tunnel when it picked another. */
export async function ownSiteSession (origin: string): Promise<object | undefined> {
  return await source?.siteSession?.(origin)
}

/**
 * `ordinary`, unless the whole browser is on the tunnel, when the request goes through it. `origin` is the website or app
 * the request is about, if any: one the person set to off is asked for directly, and a website with a tunnel of its own is asked
 * about through that tunnel's profile whatever the browser-wide setting says, since the request would otherwise show the
 * person's address (or another tunnel's exit) to a site they only open through that tunnel.
 */
export function ownFetch (ordinary: OwnFetch, origin?: string): OwnFetch {
  return async (url, init) => {
    if (source !== undefined) await sessionsFollowSetting(source)
    const current = source
    if (current === undefined) return await ordinary(url, init)
    // A website with a tunnel of its own is asked about in that tunnel, whichever tunnel the browser-wide setting names.
    const routed = origin === undefined ? undefined : await current.through?.(origin)
    if (routed !== undefined) return await routed(url, init)
    if (!current.everywhere()) return await ordinary(url, init)
    if (origin !== undefined && !current.isRouted(origin)) return await current.direct(url, init)
    return await current.tunnel(url, init)
  }
}

/**
 * A `fetch` for a request made on behalf of a tab with a tunnel choice, with no page to ask about (the address bar's suggestions as
 * the person types): it is made in that tunnel's profile session, whatever the browser-wide setting says, and it fails, it is
 * never made directly, when that session cannot be had. A `direct` choice, or none, is `ownFetch`'s own.
 */
export function ownFetchForTab (ordinary: OwnFetch, choice: TunnelKind | undefined): OwnFetch {
  if (choice === undefined) return ownFetch(ordinary)
  return async (url, init) => {
    if (source !== undefined) await sessionsFollowSetting(source)
    if (source?.profileFetch === undefined) throw new Error('the tunnel is not available, so this is not asked')
    return await source.profileFetch(choice)(url, init)
  }
}
