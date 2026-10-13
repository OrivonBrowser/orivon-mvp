// The two profile sessions websites with an entry of their own run in (`site-partition.ts`). A view is made in one the
// moment a tab needs it, so the session is held shut until its front is running (the tunnel profile) or the session is
// confirmed on the system's proxy (the direct profile): a request made in the first moments waits rather than going out
// on the wrong route. Electron-free over the parts it drives.

import { profileOrigin } from './route-hub.js'
import { profileOfPartition } from './site-partition.js'
import type { Profile } from './site-partition.js'
import type { RouteController, RouteSession } from './route-controller.js'

/** What a profile's session is cleaned with when the person removes a website's storage. */
export type SiteSession = RouteSession & {
  clearData: (options: { readonly origins: string[] }) => Promise<void>
}

export interface SiteSessionsDeps {
  readonly controller: Pick<RouteController, 'prepareSite' | 'confineSite'>
  readonly sessionFor: (partition: string) => SiteSession
  /** The host rules the session reaches without the proxy besides this machine (the names the verifier answers for). */
  readonly bypass: () => string
  /**
   * Holds every request of `session` until `current()` resolves, and refuses them all while it rejects. `current` is read
   * again whenever the returned function is called, which is when a new attempt replaced it.
   */
  readonly hold: (session: SiteSession, current: () => Promise<void>) => () => void
  /** Fits the session with what every session a website runs in carries: the privacy settings, the content blocks, the verifier's stamps. Throws when any of it could not be installed. */
  readonly fit: (session: SiteSession, profile: Profile) => void
  /** Puts the person's extensions in the session, once (`persistable`: Electron can load them there), and their request rules. Never throws: what cannot be loaded is logged. */
  readonly extend?: (session: SiteSession, persistable: boolean) => Promise<void>
}

export interface SiteSessions {
  /**
   * Makes the session ready for a view about to be made in `partition`; synchronous, and never throws: a session that cannot
   * be made ready refuses everything, and is tried again the next time a view is made in it.
   */
  ensure: (partition: string) => void
  /** Clears what a website stored in the profile session named `partition` (cookies, storage, cache), and nothing of any other website. */
  removeStorage: (partition: string, origin: string) => Promise<void>
}

interface Entry {
  current: Promise<void>
  failed: boolean
  watch: () => void
}

export function createSiteSessions (deps: SiteSessionsDeps): SiteSessions {
  const entries = new Map<string, Entry>()

  return {
    ensure: (partition) => {
      const entry = entries.get(partition)
      if (entry !== undefined && !entry.failed) return
      const profile = profileOfPartition(partition)
      const session = deps.sessionFor(partition)
      const attempt = (async () => {
        // A session name that is not a profile's: nothing says whose front it belongs to.
        if (profile === undefined) throw new Error('a view was made in a website session this process did not name')
        deps.fit(session, profile)
        await deps.controller.prepareSite(profileOrigin(profile), session, deps.bypass())
        // The extensions load after the session is held on its route, never before: they make requests of their own. Electron loads none in a session kept in memory only, which is where a plain-http website lives, so `extend` is told.
        await deps.extend?.(session, partition.startsWith('persist:'))
      })().catch(async (error: unknown) => {
        console.error('[route] could not point a website\'s session at its route:', error)
        await deps.controller.confineSite(session)
        throw error
      })
      const fresh: Entry = entry ?? { current: attempt, failed: false, watch: () => {} }
      fresh.current = attempt
      fresh.failed = false
      attempt.then(() => {}, () => { if (fresh.current === attempt) fresh.failed = true })
      if (entry === undefined) {
        entries.set(partition, fresh)
        fresh.watch = deps.hold(session, () => fresh.current)
      } else {
        fresh.watch()
      }
    },
    removeStorage: async (partition, origin) => {
      await deps.sessionFor(partition).clearData({ origins: [origin] })
    }
  }
}
