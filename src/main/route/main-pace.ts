// The patience of the requests main itself makes (a Web3 Score lookup, an icon): the route they leave by, as the
// protocols' pace seam describes it. One meter for the tunnel, so what one lookup learned of how slow it is, the next
// one is patient for.

import { DIRECT_ROUTE, RouteMeter, TUNNEL_PROFILE } from '../../protocols/route-pace.js'
import type { RoutePace } from '../../protocols/route-pace.js'

const tunnel = new RouteMeter(TUNNEL_PROFILE)

/** The pace of a request that leaves through the tunnel (`tunnelled`) or the ordinary way. */
export function mainRoutePace (tunnelled: boolean): RoutePace {
  return tunnelled ? tunnel : DIRECT_ROUTE
}
