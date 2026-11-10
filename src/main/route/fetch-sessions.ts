// The session a lookup about a routed origin is made through: a website's own, which is already prepared with the identity it
// shares, or an in-memory one of the origin's own that is pointed at its front. Electron-free over the sessions it is handed.

import { originHash } from '../../broker/grants/origin-hash.js'
import { SHARED_ORIGIN } from './route-hub.js'
import type { RouteHub } from './route-hub.js'
import { profilePartitionFor } from './site-partition.js'
import { ensureSiteSession } from './site-routes.js'

export interface FetchSessionsDeps<S> {
  readonly hub: RouteHub
  /** Whether `origin` is an installed app: any other origin is a website. */
  readonly isApp: (origin: string) => boolean
  readonly sessionFor: (partition: string) => S
  readonly defaultSession?: (() => S) | undefined
  /** Points `session` at the origin's front, for the lookups made about an app. */
  readonly prepare: (origin: string, session: S) => Promise<void>
}

export interface FetchSessions<S> {
  /** The session to look `origin` up through; undefined when it is not routed. */
  readonly forOrigin: (origin: string) => Promise<S | undefined>
  /** The origin is gone: its lookup session is made anew if it is routed again. */
  readonly forget: (origin: string) => void
}

export function createFetchSessions<S> (deps: FetchSessionsDeps<S>): FetchSessions<S> {
  const { hub } = deps
  const made = new Map<string, S>()
  return {
    forOrigin: async (origin) => {
      if (!hub.isRouted(origin)) return undefined
      if (!deps.isApp(origin)) {
        // A website is looked up about through the session it runs in, which is already prepared with the identity it shares: the tunnel profile's, or the default session when the whole browser is on the tunnel.
        const profile = hub.profileFor(origin)
        if (profile !== undefined && profile !== 'direct') {
          // Made ready as a tab's view would: held shut until it is pointed at its front, never left on the system's proxy. No view is coming, so the extensions are not woken.
          const partition = profilePartitionFor(profile, origin)
          ensureSiteSession(partition, false)
          return deps.sessionFor(partition)
        }
        const shared = deps.defaultSession?.()
        if (profile === undefined && shared !== undefined && hub.isRouted(SHARED_ORIGIN)) return shared
      }
      let session = made.get(origin)
      if (session === undefined) {
        session = deps.sessionFor(`orivon-route-fetch-${originHash(origin)}`)
        made.set(origin, session)
      }
      await deps.prepare(origin, session)
      return session
    },
    forget: (origin) => { made.delete(origin) }
  }
}
