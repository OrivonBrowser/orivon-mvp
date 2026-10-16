// Which route a request to the verifier travels, and how patient that route is. Pure over the request's headers.

import type { IncomingMessage } from 'node:http'
import { ROUTE_HEADER } from '../../../loader/fetch/content-root.js'
import type { RoutePace } from '../../route-pace.js'
import type { FetchRoute, TunnelRoute } from '../protocol.js'

/**
 * How this request's fetches must leave: through the tunnel the shell marked it with, when it is a website in a tunnel's
 * profile. The shell sets or strips the mark on every request of a website session, so a page cannot name its own; and a
 * request with no mark is a direct website's, never a tunnel profile's.
 */
export function routeOf (req: IncomingMessage): FetchRoute {
  const marked = req.headers[ROUTE_HEADER]
  return marked === 'nym' || marked === 'socks5' ? marked : 'direct'
}

/** The pace of each route a request may travel: how long a failed read waits before it is made again. */
export interface ServeRoutes {
  readonly direct: RoutePace
  /** The pace of a tunnel's websites: asked at each read, since a tunnel's is made when its first website is. */
  readonly tunnel: (route: TunnelRoute) => RoutePace
}

export function paceOf (route: FetchRoute, routes: ServeRoutes): RoutePace {
  return route === 'direct' ? routes.direct : routes.tunnel(route)
}

