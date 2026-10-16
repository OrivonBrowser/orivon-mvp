// What the address bar's tunnel button says about the page in front. Pure.

import type { RouteState } from './route-hub.js'
import type { TunnelKind } from './route-state.js'

/**
 * `on`: the page's traffic goes through the tunnel. `down`: the page is on the tunnel and the tunnel does not carry it.
 * Null: the page is not on the tunnel.
 */
export type TunnelMark = 'on' | 'down'

export interface TunnelFacts {
  /** The route state of the page's origin. */
  readonly state: RouteState
  /** The page runs in a temporary session opened through the tunnel from a routed app. */
  readonly temporary: boolean
}

export function tunnelMarkFor ({ state, temporary }: TunnelFacts): TunnelMark | null {
  if (temporary) return state === 'no-proxy' || state === 'down' ? 'down' : 'on'
  switch (state) {
    case 'off': return null
    case 'no-proxy':
    case 'down': return 'down'
    case 'idle':
    case 'ok': return 'on'
  }
}

/** What the tunnel button says about the page in front: the mark, and the tunnel it goes through (null when it is not on a tunnel). */
export interface TunnelLook {
  readonly mark: TunnelMark | null
  readonly via: TunnelKind | null
}

export interface TunnelLookFacts extends TunnelFacts {
  /** The tunnel the page's own origin goes through. */
  readonly own: TunnelKind | undefined
  /** How the session the page runs in leaves (`RouteController.tunnelOf`). */
  readonly session: TunnelKind | 'held' | undefined
}

/**
 * A page that runs in a session pointed at a tunnel its own origin does not use (a popup adopted into an app's session, a page
 * opened through an app's tunnel) goes through that session's tunnel, not through none: it is on it, and the route state of
 * its own origin says nothing about it.
 */
export function tunnelLookFor ({ state, temporary, own, session }: TunnelLookFacts): TunnelLook {
  const inSession = session === undefined || session === 'held' ? undefined : session
  const opened = inSession !== undefined && inSession !== own
  const mark = tunnelMarkFor({ state: opened && !temporary ? 'idle' : state, temporary })
  return { mark, via: mark === null ? null : (opened ? inSession : own) ?? null }
}
