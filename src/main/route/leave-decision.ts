// Whether a page of a routed app starting a navigation or a window needs the person asked first: the address leaves
// the sessions the app's route covers. Pure; the callers say who started it (a person's own navigation never comes here).

import { originFromUrl } from '../../broker/policy/origin.js'

/** What the decision reads about the world, so it runs without a window or a store. */
export interface LeaveWorld {
  /** Whether the app at `origin` is switched on for the proxy. */
  readonly isRouted: (origin: string) => boolean
  /** Whether `origin` is an installed app, one whose own session serves it from the cache. */
  readonly isInstalledApp: (origin: string) => boolean
  /** The routed app whose own session is `partition`, if any: a document with no web address (`about:blank`, `data:`) still runs as that app. */
  readonly routedOriginOf: (partition: string | undefined) => string | undefined
}

/** `app` is the routed app whose page asks; `origin` is what it wants to open. */
export type Leave =
  | { readonly kind: 'website', readonly origin: string, readonly app: string }
  | { readonly kind: 'app', readonly origin: string, readonly app: string }

/**
 * The routed app the page at `url` in `partition` is: by its address (a `blob:` URL by the origin that made it), and
 * for a document with no web address by the app session it runs in. Undefined for any other page.
 */
export function routedPageOrigin (url: string, partition: string | undefined, world: LeaveWorld): string | undefined {
  const own = originFromUrl(url) ?? (url.startsWith('blob:') ? originFromUrl(url.slice('blob:'.length)) : null)
  if (own !== null) return world.isRouted(own) ? own : undefined
  return world.routedOriginOf(partition)
}

/**
 * What asking is about, or undefined when the open needs no question: the page is not a routed app's, the address is
 * the app's own, has no web origin, or is an installed app whose route is on (it opens in its own routed session).
 * A loopback address is asked about too: it loads in the shared session, where whatever it then opens is direct.
 */
export function leavesRoute (fromUrl: string, toUrl: string, world: LeaveWorld, fromPartition?: string): Leave | undefined {
  const from = routedPageOrigin(fromUrl, fromPartition, world)
  if (from === undefined) return undefined
  const to = originFromUrl(toUrl)
  if (to === null || to === from) return undefined
  if (world.isInstalledApp(to)) return world.isRouted(to) ? undefined : { kind: 'app', origin: to, app: from }
  return { kind: 'website', origin: to, app: from }
}
