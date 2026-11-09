// The Electron half of the cookie mirror: the sessions it works on, the setting that switches it, and the profile sessions that
// already hold cookies on disk. Tied to Electron.
import { existsSync } from 'node:fs'
import { session } from 'electron'
import type { Cookie, Event as ElectronEvent, Session } from 'electron'
import { forEachWebsiteSession } from '../../sessions/website-sessions.js'
import { profileFolder } from '../kinds-migration.js'
import { within } from '../within.js'
import { PROFILES, profilePartition } from '../site-partition.js'
import { ensureSiteSession } from '../site-routes.js'
import { createCookieMirror } from './cookie-mirror.js'
import { setCookieMirrorStatusSource } from './mirror-status.js'
import { joinsMirror } from './members.js'
import { holdForMerge } from './session-ready.js'
import type { ChangeCause, CookieStore } from './cookies.js'

const KEY = 'network.tunnel.separateSignIns'
/** A session's first request waits this long for its cookies at most; a mirror that is slow or failing must not keep a page from loading. */
const MERGE_WAIT_MS = 8000

export interface CookieMirrorSettings {
  readonly get: (key: typeof KEY) => boolean
  readonly onChange: (listener: (change: { readonly key: string }) => void) => () => void
}

/** A session's cookies as the mirror asks for them. */
function storeOf (target: Session): CookieStore {
  const { cookies } = target
  return {
    all: async () => await cookies.get({}),
    find: async (name, domain) => await cookies.get(domain === undefined ? { name } : { name, domain }),
    set: async (details) => { await cookies.set(details) },
    remove: async (url, name) => { await cookies.remove(url, name) },
    watch: (listener) => {
      const heard = (_event: ElectronEvent, cookie: Cookie, cause: ChangeCause, removed: boolean): void => { listener(cookie, cause, removed) }
      cookies.on('changed', heard)
      return () => { cookies.off('changed', heard) }
    },
    clear: async () => { await target.clearData({ dataTypes: ['cookies'] }) },
    flush: async () => { await cookies.flushStore() }
  }
}

/**
 * With "Keep tunneled sites separate" off, keeps the cookies of the profile sessions and of the default session in step; with it on,
 * leaves them apart, and clears the profiles' cookies when it is turned back on. Call once the settings are read. A private window's
 * process has no mirror: its sessions are its own.
 */
export function installCookieMirror (options: { readonly settings: CookieMirrorSettings, readonly isPrivate: boolean, readonly userData: string }): void {
  if (options.isPrivate) return
  const mirror = createCookieMirror({ main: { label: 'default', store: storeOf(session.defaultSession) }, now: Date.now, log: (line) => { console.info(line) } })
  setCookieMirrorStatusSource(mirror.status)
  // A profile session made after this joins as it is announced; the installer never throws, or the session would be refused.
  forEachWebsiteSession((target, _tunnel, partition) => {
    if (partition === undefined || !joinsMirror(partition, false)) return
    try {
      holdForMerge(target, within(mirror.join({ label: partition.slice('persist:'.length), store: storeOf(target) }), MERGE_WAIT_MS).catch(() => {}))
    } catch (error) {
      console.error('[cookie-mirror] a profile session could not join:', error)
    }
  })
  const separate = (): boolean => options.settings.get(KEY)
  /** A profile with data on disk is made now, so a sign-in deleted in the default session meanwhile cannot come back from it when it is first used. */
  const bringInKeptProfiles = (): void => {
    for (const profile of PROFILES) {
      if (!existsSync(profileFolder(options.userData, profile))) continue
      try {
        ensureSiteSession(profilePartition(profile, true), false)
      } catch (error) {
        console.error('[cookie-mirror] a profile session could not be made ready:', error)
      }
    }
  }
  const apply = (): void => {
    if (separate()) {
      mirror.stop().catch(() => {})
      return
    }
    // Asked first, so a profile made just below is joined as one the first merge holds its first request for.
    const started = mirror.start()
    bringInKeptProfiles()
    started.catch(() => {})
  }
  if (!separate()) apply()
  options.settings.onChange(({ key }) => { if (key === KEY) apply() })
}
