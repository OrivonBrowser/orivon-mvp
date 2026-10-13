// A website opened through the proxy runs in a session of its own that is released with its last tab.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryRoutes, isTemporaryRoutePartition } from '../temporary-routes.js'
import type { TemporaryRoutes, TemporaryRoutesDeps, TemporarySession } from '../temporary-routes.js'

const made: TemporaryRoutes[] = []
afterEach(async () => { for (const routes of made.splice(0)) await routes.dispose() })

function setup (options: { unusedMs?: number, prepare?: () => Promise<void> } = {}) {
  const sessions = new Map<string, TemporarySession & { cleared: string[] }>()
  const live = new Map<object, number>()
  let gone: ((session: object) => void) | undefined
  const prepared: Array<{ session: object, port: number, username: string }> = []
  const released: object[] = []
  const deps: TemporaryRoutesDeps = {
    controller: {
      prepareTemporary: async (session, front) => { await options.prepare?.(); prepared.push({ session, port: front.port, username: front.username }) },
      releaseTemporary: (session) => { released.push(session) }
    },
    proxy: () => ({ host: '127.0.0.1', port: 9050 }),
    sessionFor: (partition) => {
      let session = sessions.get(partition)
      if (session === undefined) {
        const cleared: string[] = []
        session = {
          cleared,
          setProxy: async () => {},
          closeAllConnections: async () => { cleared.push('connections') },
          clearStorageData: async () => { cleared.push('storage') },
          clearCache: async () => { cleared.push('cache') }
        }
        sessions.set(partition, session)
      }
      return session
    },
    liveContentsIn: (session) => live.get(session) ?? 0,
    onContentsGone: (listener) => { gone = listener },
    ...(options.unusedMs === undefined ? {} : { unusedMs: options.unusedMs })
  }
  const routes = createTemporaryRoutes(deps)
  made.push(routes)
  return { routes, sessions, live, prepared, released, closeTab: (session: object) => { live.set(session, (live.get(session) ?? 1) - 1); gone?.(session) } }
}

describe('a temporary routed session', () => {
  it('is in memory, pointed at a front of its own, and recognised as one of these', async () => {
    const { routes, sessions, prepared } = setup()
    const partition = await routes.open()
    expect(partition.startsWith('persist:')).toBe(false)
    expect(isTemporaryRoutePartition(partition)).toBe(true)
    expect(isTemporaryRoutePartition('persist:app-abc')).toBe(false)
    expect(isTemporaryRoutePartition(undefined)).toBe(false)
    const session = sessions.get(partition) as TemporarySession
    expect(routes.owns(session)).toBe(true)
    expect(routes.owns({})).toBe(false)
    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.session).toBe(session)
  })

  it('gets a front, and so credentials, that no other temporary session shares', async () => {
    const { routes, prepared } = setup()
    await routes.open()
    await routes.open()
    expect(prepared).toHaveLength(2)
    expect(prepared[0]?.port).not.toBe(prepared[1]?.port)
  })

  it('keeps its storage while a tab uses it and clears all of it when the last tab closes', async () => {
    const { routes, sessions, live, released, closeTab } = setup()
    const partition = await routes.open()
    const session = sessions.get(partition) as TemporarySession & { cleared: string[] }
    live.set(session, 2)

    closeTab(session)
    await vi.waitFor(() => { expect(session.cleared).toEqual([]) })
    expect(routes.count()).toBe(1)

    closeTab(session)
    await vi.waitFor(() => { expect(routes.count()).toBe(0) })
    expect(session.cleared.sort()).toEqual(['cache', 'connections', 'storage'])
    expect(released).toEqual([session])
    expect(routes.owns(session)).toBe(false)
  })

  it('is released when no tab ever opens in it', async () => {
    const { routes } = setup({ unusedMs: 20 })
    await routes.open()
    expect(routes.count()).toBe(1)
    await vi.waitFor(() => { expect(routes.count()).toBe(0) })
  })

  it('is released, and the failure passed on, when it cannot be pointed at its front', async () => {
    const { routes } = setup({ prepare: async () => { throw new Error('no session') } })
    await expect(routes.open()).rejects.toThrow('no session')
    expect(routes.count()).toBe(0)
  })
})
