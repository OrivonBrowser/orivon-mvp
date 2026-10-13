// A website a routed app's page opens "through my tunnel" runs in a session made for it: in memory, behind a front of its
// own that signs in to the proxy with credentials of its own (so Tor gives it circuits apart from the app's), and gone
// with the last tab that used it. Electron-free over the parts it drives.

import { randomBytes } from 'node:crypto'
import { createSocks5Provider, isolationCredentials } from '../../broker/route/socks5.js'
import { createRouteFor } from '../../broker/route/table.js'
import type { RouteTarget } from '../../broker/route/table.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { startRouteFront } from './front.js'
import type { RouteFront } from './front.js'
import type { RouteController, RouteSession } from './route-controller.js'

/** A name no `persist:` prefix is on, so Electron keeps the session in memory. */
const PREFIX = 'orivon-route-tab-'

/** Whether `partition` is the name of a temporary routed session. */
export function isTemporaryRoutePartition (partition: string | undefined): boolean {
  return partition !== undefined && partition.startsWith(PREFIX)
}

/**
 * The temporary session a live page of `origin` runs in, if any: what the browser's own lookups about that site go
 * through, so they leave by the same route as the page. Undefined when no temporary tab shows the site.
 */
export function temporarySessionShowing (
  contents: Iterable<{ readonly session: object, readonly getURL: () => string, readonly isDestroyed: () => boolean }>,
  owns: (session: object | undefined) => boolean,
  origin: string
): object | undefined {
  for (const page of contents) {
    if (!page.isDestroyed() && owns(page.session) && originFromUrl(page.getURL()) === origin) return page.session
  }
  return undefined
}

/** What a temporary session is cleaned with when its last tab is gone. */
export type TemporarySession = RouteSession & {
  clearStorageData: () => Promise<void>
  clearCache: () => Promise<void>
}

export interface TemporaryRoutesDeps {
  readonly controller: Pick<RouteController, 'prepareTemporary' | 'releaseTemporary'>
  /** The proxy now, read on every connection. */
  readonly proxy: () => RouteTarget | undefined
  readonly sessionFor: (partition: string) => TemporarySession
  /** How many web contents are alive in the session. */
  readonly liveContentsIn: (session: TemporarySession) => number
  /** Called when a web contents that ran in `session` is gone. */
  readonly onContentsGone: (listener: (session: object) => void) => void
  /** A session that nothing opens in is released after this long. */
  readonly unusedMs?: number
}

export interface TemporaryRoutes {
  /** A new session pointed at a front of its own: the partition name a tab is made in. */
  open: () => Promise<string>
  /** Whether `session` is one of these. */
  owns: (session: object | undefined) => boolean
  /** Whether the session named `partition` is alive: a tab made in a released one would get a bare session, which is not routed. */
  isLive: (partition: string) => boolean
  /** Sessions alive, for tests and for a quiet shutdown. */
  count: () => number
  dispose: () => Promise<void>
}

const UNUSED_MS = 30_000

interface Held { readonly session: TemporarySession, readonly front: RouteFront }

export function createTemporaryRoutes (deps: TemporaryRoutesDeps): TemporaryRoutes {
  const credentials = isolationCredentials()
  const held = new Map<string, Held>()
  const bySession = new Map<object, string>()

  async function release (partition: string): Promise<void> {
    const entry = held.get(partition)
    if (entry === undefined) return
    held.delete(partition)
    bySession.delete(entry.session)
    deps.controller.releaseTemporary(entry.session, entry.front)
    // Together: a call into the session that never returns must not keep the front listening.
    await Promise.allSettled([
      entry.session.clearStorageData(),
      entry.session.clearCache(),
      entry.session.closeAllConnections(),
      entry.front.close()
    ])
  }

  deps.onContentsGone((session) => {
    const partition = bySession.get(session)
    if (partition === undefined) return
    const entry = held.get(partition)
    if (entry !== undefined && deps.liveContentsIn(entry.session) === 0) void release(partition).catch((error: unknown) => { console.error('[route] releasing a temporary session failed:', error) })
  })

  return {
    open: async () => {
      const partition = `${PREFIX}${randomBytes(9).toString('hex')}`
      const key = `temporary-tab:${partition}`
      const routeFor = createRouteFor({
        targetFor: () => deps.proxy(),
        providerFor: (_key, target) => createSocks5Provider({ host: target.host, port: target.port, credentials: credentials(key) })
      })
      const session = deps.sessionFor(partition)
      const front = await startRouteFront({ provider: () => routeFor(key)?.provider })
      held.set(partition, { session, front })
      bySession.set(session, partition)
      try {
        await deps.controller.prepareTemporary(session, front)
      } catch (error) {
        await release(partition)
        throw error
      }
      // A tab that never opened in it (the browser was at its tab limit) leaves nothing behind.
      setTimeout(() => {
        if (held.has(partition) && deps.liveContentsIn(session) === 0) void release(partition).catch(() => {})
      }, deps.unusedMs ?? UNUSED_MS).unref()
      return partition
    },
    owns: (session) => session !== undefined && bySession.has(session),
    isLive: (partition) => held.has(partition),
    count: () => held.size,
    dispose: async () => { await Promise.all([...held.keys()].map(release)) }
  }
}
