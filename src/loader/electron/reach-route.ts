// Which route, if any, the third-party reach of an app's requests goes through. Main supplies the answer once, for
// the whole process; the loader reads it per request, so an app switched on or off is followed at once.

import type { RouteFor, RouteProvider } from '../../broker/route/provider.js'

let source: RouteFor | undefined

/** Called once at start by whoever owns the routes. */
export function setReachRoute (routeFor: RouteFor): void {
  source = routeFor
}

/** For `nodeReachDial`'s `routeProvider`: the route of `origin`'s app, or undefined when it has none. */
export function reachRouteOf (origin: string): () => RouteProvider | undefined {
  return () => source?.(origin)?.provider
}
