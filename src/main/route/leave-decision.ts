// Whether a page of a routed app starting a navigation or a window needs the person asked first: the address leaves
// the sessions the app's route covers. Pure; the callers say who started it (a person's own navigation never comes here).

import { isLoopbackHost, originFromUrl } from '../../broker/policy/origin.js'

/** What the decision reads about the world, so it runs without a window or a store. */
export interface LeaveWorld {
  /** Whether the app at `origin` is switched on for the proxy. */
  readonly isRouted: (origin: string) => boolean
  /** Whether `origin` is an installed app, one whose own session serves it from the cache. */
  readonly isInstalledApp: (origin: string) => boolean
}

export type Leave =
  | { readonly kind: 'website', readonly origin: string }
  | { readonly kind: 'app', readonly origin: string }

/**
 * What asking is about, or undefined when the open needs no question: the page is not a routed app's, the address is
 * the app's own, has no web origin, is on this computer (it never leaves it), or is an installed app whose route is on (it opens in its own routed session).
 */
export function leavesRoute (fromUrl: string, toUrl: string, world: LeaveWorld): Leave | undefined {
  const from = originFromUrl(fromUrl)
  if (from === null || !world.isRouted(from)) return undefined
  const to = originFromUrl(toUrl)
  if (to === null || to === from || isLoopbackHost(new URL(toUrl).hostname)) return undefined
  if (world.isInstalledApp(to)) return world.isRouted(to) ? undefined : { kind: 'app', origin: to }
  return { kind: 'website', origin: to }
}
