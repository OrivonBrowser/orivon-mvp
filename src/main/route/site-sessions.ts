// The sessions of websites that have a tunnel state of their own. A view is made in one the moment a tab needs it, so
// the session is held shut until its front is running: a request made in the first moments waits for the proxy rather
// than going out on the system's. Electron-free over the parts it drives.

import { siteOriginOf } from './site-routes.js'
import type { RouteController, RouteSession } from './route-controller.js'

/** What a site's session is cleaned with when the person removes its storage. */
export type SiteSession = RouteSession & {
  clearStorageData: () => Promise<void>
  clearCache: () => Promise<void>
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
  readonly fit: (session: SiteSession) => void
}

export interface SiteSessions {
  /**
   * Makes the session ready for a view about to be made in `partition`; synchronous, and never throws: a session that cannot
   * be made ready refuses everything, and is tried again the next time a view is made in it.
   */
  ensure: (partition: string) => void
  /** Clears what the website's own session stored (cookies, storage, cache). */
  removeStorage: (partition: string) => Promise<void>
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
      const origin = siteOriginOf(partition)
      const session = deps.sessionFor(partition)
      const attempt = (async () => {
        // A session name this process did not hand out: nothing says whose front it belongs to.
        if (origin === undefined) throw new Error('a view was made in a website session this process did not name')
        deps.fit(session)
        await deps.controller.prepareSite(origin, session, deps.bypass())
      })().catch(async (error: unknown) => {
        console.error('[route] could not point a website\'s session at its tunnel:', error)
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
    removeStorage: async (partition) => {
      const session = deps.sessionFor(partition)
      await Promise.all([session.clearStorageData(), session.clearCache()])
    }
  }
}
