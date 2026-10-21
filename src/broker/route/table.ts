// Which route an origin key has, as a pure function over what main stores.
// The store (the person's proxy and the per-app switch) lives in main; this
// turns a lookup into a `RouteFor` and builds one provider per key, again only
// when the proxy it points at changes.

import type { Route, RouteFor, RouteProvider } from './provider.js'

/** Where a route's proxy listens. */
export interface RouteTarget {
  readonly host: string
  readonly port: number
}

export interface RouteTableOptions {
  /** The proxy an origin key is routed through now, or undefined when it has none. Read on every call, so a change applies to the next one. */
  readonly targetFor: (key: string) => RouteTarget | undefined
  /** Builds the provider for one key and proxy. Called again for a key only when its proxy changed. */
  readonly providerFor: (key: string, target: RouteTarget) => RouteProvider
}

export function createRouteFor ({ targetFor, providerFor }: RouteTableOptions): RouteFor {
  const built = new Map<string, { readonly host: string, readonly port: number, readonly route: Route }>()
  return (key) => {
    const target = targetFor(key)
    if (target === undefined) {
      built.delete(key)
      return undefined
    }
    const known = built.get(key)
    if (known !== undefined && known.host === target.host && known.port === target.port) return known.route
    const route: Route = { provider: providerFor(key, target) }
    built.set(key, { host: target.host, port: target.port, route })
    return route
  }
}
