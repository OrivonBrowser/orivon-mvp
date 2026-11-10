// The Electron half of the cookie mirror: the sessions it works on, the setting that switches it, the record of what it mirrors, and
// the wait before a tunnelled tab loads a site it has not mirrored yet. Tied to Electron.
import { join } from 'node:path'
import { app, session } from 'electron'
import type { Cookie, Event as ElectronEvent, Session } from 'electron'
import { forEachWebsiteSession } from '../../sessions/website-sessions.js'
import { webRequestOwnerFor } from '../../sessions/web-request-owner.js'
import type { WebRequestHandlerHandle } from '../../sessions/web-request-owner.js'
import { within } from '../within.js'
import { createCookieMirror } from './cookie-mirror.js'
import { siteOfCookie } from './cookies.js'
import { joinsMirror } from './members.js'
import { setCookieMirrorForgetter } from './mirror-forget.js'
import { readMirrorRecord, writeMirrorRecord } from './mirror-record.js'
import { setCookieMirrorStatusSource } from './mirror-status.js'
import { createNavigationHops } from './navigation-hops.js'
import { holdForMerge } from './session-ready.js'
import type { ChangeCause, CookieStore } from './cookies.js'

const KEY = 'network.tunnel.separateSignIns'
/** A page load waits this long for its site's cookies at most; a mirror that is slow or failing must not keep a page from loading. */
const MERGE_WAIT_MS = 8000
export const RECORD_FILE = 'cookie-mirror.json'
/** After the session's own holds (-1) and the verifier's (0). */
const VISIT_ORDER = 50

/** A profile session a page load is waited for in: the handler is there while the mirror is on. */
interface Visiting {
  readonly label: string
  handle?: WebRequestHandlerHandle | undefined
}

export interface CookieMirrorSettings {
  readonly get: (key: typeof KEY) => boolean
  readonly onChange: (listener: (change: { readonly key: string }) => void) => () => void
}

/** A session's cookies as the mirror asks for them. */
function storeOf (target: Session): CookieStore {
  const { cookies } = target
  return {
    list: async (sites) => {
      const wanted = new Set(sites)
      return (await cookies.get({})).filter((cookie) => wanted.has(siteOfCookie(cookie) ?? ''))
    },
    find: async (address, name) => await cookies.get({ url: address, name }),
    set: async (details) => { await cookies.set(details) },
    remove: async (url, name) => { await cookies.remove(url, name) },
    watch: (listener) => {
      const heard = (_event: ElectronEvent, cookie: Cookie, cause: ChangeCause, removed: boolean): void => { listener(cookie, cause, removed) }
      cookies.on('changed', heard)
      return () => { cookies.off('changed', heard) }
    },
    flush: async () => { await cookies.flushStore() }
  }
}

/**
 * With "Keep tunneled sites separate" off, keeps the cookies of the sites a person opens in a tunnelled tab the same in the profile
 * sessions and in the default session; with it on, leaves them apart, and clears the profiles' copies when it is turned back on
 * (or at the next start, if that was cut short). Call once the settings are read. A private window's process has no mirror: its
 * sessions are its own.
 */
export function installCookieMirror (options: { readonly settings: CookieMirrorSettings, readonly isPrivate: boolean, readonly userData: string }): void {
  if (options.isPrivate) return
  const recordPath = join(options.userData, RECORD_FILE)
  const mirror = createCookieMirror({
    main: { label: 'default', store: storeOf(session.defaultSession) },
    record: { read: () => readMirrorRecord(recordPath), write: (record) => writeMirrorRecord(recordPath, record) },
    open: (label) => {
      try {
        return storeOf(session.fromPartition(`persist:${label}`))
      } catch {
        return undefined
      }
    },
    now: Date.now,
    log: (line) => { console.info(line) }
  })
  setCookieMirrorStatusSource(mirror.status)
  setCookieMirrorForgetter(mirror.forget)
  const separate = (): boolean => options.settings.get(KEY)
  const hops = createNavigationHops()
  /** The profile sessions a page load is waited for in, and the handler that waits while the mirror is on. */
  const visiting = new Map<Session, Visiting>()
  const arm = (target: Session, entry: Visiting): void => {
    entry.handle ??= webRequestOwnerFor(target).onBeforeRequest(VISIT_ORDER, { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, () => true, async (details, soFar) => {
      // The owner calls every handler of a session for a request its filter union covers, so the type is checked here: only a tab's own page is a site it opened.
      if (details.resourceType !== 'mainFrame') return soFar
      const hop = hops.classify({
        id: details.id,
        referrer: details.referrer,
        ...(details.webContentsId === undefined ? {} : { webContentsId: details.webContentsId }),
        ...(details.initiatorOrigin === undefined ? {} : { initiatorOrigin: details.initiatorOrigin })
      })
      // Only the first request of a navigation the person started adds a site before its page loads: a page's own navigation and a redirect hop are not the person's choice of site.
      const waiting = mirror.visit(entry.label, details.url, hop === 'browser')
      if (waiting === undefined) return soFar
      try {
        await within(waiting, MERGE_WAIT_MS)
      } catch {
        // A slow or failing mirror loads the page without the cookies.
      }
      return soFar
    })
  }
  const disarm = (entry: Visiting): void => {
    entry.handle?.remove()
    entry.handle = undefined
  }
  // A profile session made after this joins as it is announced; the installer never throws, or the session would be refused.
  forEachWebsiteSession((target, _tunnel, partition) => {
    if (partition === undefined || !joinsMirror(partition, false)) return
    try {
      const label = partition.slice('persist:'.length)
      const entry: Visiting = { label }
      visiting.set(target, entry)
      if (!separate()) arm(target, entry)
      holdForMerge(target, within(mirror.join({ label, store: storeOf(target) }), MERGE_WAIT_MS).catch(() => {}))
    } catch (error) {
      console.error('[cookie-mirror] a profile session could not join:', error)
    }
  })
  // A site is added for good when a navigation to it commits as a tab's page, whoever started it.
  app.on('web-contents-created', (_event, contents) => {
    const entry = visiting.get(contents.session)
    if (entry === undefined) return
    const id = contents.id
    contents.once('destroyed', () => { hops.forget(id) })
    contents.on('did-navigate', (_navigated, url) => {
      if (separate() || !/^https?:\/\//i.test(url)) return
      mirror.committed(entry.label, url).catch(() => {})
    })
  })
  const apply = (): void => {
    if (separate()) {
      for (const entry of visiting.values()) disarm(entry)
      mirror.stop().catch(() => {})
      return
    }
    const started = mirror.start()
    for (const [target, entry] of visiting) arm(target, entry)
    started.catch(() => {})
  }
  if (separate()) mirror.settle().catch(() => {})
  else apply()
  options.settings.onChange(({ key }) => { if (key === KEY) apply() })
}
