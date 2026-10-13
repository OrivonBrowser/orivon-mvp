// What the address bar's key says about the page in front and the tunnel. Pure.

import type { RouteState } from './route-hub.js'

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
