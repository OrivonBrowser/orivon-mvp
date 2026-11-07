// Whether a session may send an onion address (`.onion`) out: only the person's own SOCKS5 tunnel can, because it passes the
// name on unresolved. Any other route would look the name up (a resolver then learns which hidden service the person is
// about to visit) or, through Nym, send the lookup to a public resolver that cannot answer for it. Pure: no `electron`.

import { isOnionUrl } from '../../broker/route/onion.js'
import type { TunnelKind } from './route-state.js'

/** How a session sends: the tunnel of the front it is pointed at, `held` when it is stopped, undefined when it follows the system (`RouteController.tunnelOf`). */
export type SessionRoute = TunnelKind | 'held' | undefined

/** Whether a request for `url` made in a session that sends as `via` is cancelled before anything is resolved. */
export function onionRefused (url: string, via: SessionRoute): boolean {
  return via !== 'socks5' && isOnionUrl(url)
}
