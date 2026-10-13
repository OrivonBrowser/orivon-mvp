import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSiteRoutes } from '../site-routes.js'
import { sitePartitionFor } from '../site-partition.js'
import { sitePartitionForOrigin } from '../site-routes.js'
import { createSiteSessions } from '../site-sessions.js'
import type { SiteSession, SiteSessionsDeps } from '../site-sessions.js'

const SITE = 'https://news.example'
afterEach(() => { setSiteRoutes(undefined) })

function setup (prepare: () => Promise<void> = async () => {}) {
  const log: string[] = []
  const sessions = new Map<string, SiteSession>()
  const sessionFor = (partition: string): SiteSession => {
    let one = sessions.get(partition)
    if (one === undefined) {
      one = {
        setProxy: async () => {},
        closeAllConnections: async () => {},
        clearStorageData: async () => { log.push(`clear ${partition}`) },
        clearCache: async () => { log.push(`clearCache ${partition}`) }
      }
      sessions.set(partition, one)
    }
    return one
  }
  const held: Array<{ session: SiteSession, ready: () => Promise<void>, watched: number }> = []
  const deps: SiteSessionsDeps = {
    controller: {
      prepareSite: vi.fn(async (origin: string, _session: RouteSessionLike, bypass: string) => { log.push(`prepare ${origin} ${bypass}`); await prepare() }),
      confineSite: vi.fn(async () => { log.push('confine') })
    },
    sessionFor,
    bypass: () => '*.eth',
    hold: (session, ready) => { const one = { session, ready, watched: 0 }; held.push(one); return () => { one.watched += 1 } },
    fit: () => { log.push('fit') }
  }
  return { sites: createSiteSessions(deps), deps, held, log, sessionFor }
}
type RouteSessionLike = object

describe('making a website\'s session ready', () => {
  it('prepares it for the origin its name stands for, with the verifier\'s names, and holds its requests until then', async () => {
    setSiteRoutes({ usesOwnSession: () => true })
    const partition = sitePartitionForOrigin(SITE) as string
    const { sites, held, log } = setup()

    sites.ensure(partition)

    expect(held).toHaveLength(1)
    await held[0]?.ready()
    expect(log).toEqual(['fit', `prepare ${SITE} *.eth`])
  })

  it('does it once for a session, however many views are made in it', () => {
    setSiteRoutes({ usesOwnSession: () => true })
    const partition = sitePartitionForOrigin(SITE) as string
    const { sites, held, deps } = setup()

    sites.ensure(partition)
    sites.ensure(partition)

    expect(held).toHaveLength(1)
    expect(deps.controller.prepareSite).toHaveBeenCalledTimes(1)
  })

  it('confines a session that could not be pointed, and keeps refusing its requests', async () => {
    setSiteRoutes({ usesOwnSession: () => true })
    const partition = sitePartitionForOrigin(SITE) as string
    const { sites, held, log } = setup(async () => { throw new Error('no front') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(partition)

    await expect(held[0]?.ready()).rejects.toThrow(/no front/)
    expect(log).toContain('confine')
  })

  it('refuses everything in a session whose origin this process never named', async () => {
    const { sites, held, deps } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(sitePartitionFor('https://never-asked.example'))

    expect(deps.controller.prepareSite).not.toHaveBeenCalled()
    await expect(held[0]?.ready()).rejects.toThrow()
  })
})

describe('a session that could not be made ready', () => {
  it('is tried again the next time a view is made in it, and its hold is told to look again', async () => {
    setSiteRoutes({ usesOwnSession: () => true })
    const partition = sitePartitionForOrigin(SITE) as string
    let failing = true
    const { sites, held, deps } = setup(async () => { if (failing) throw new Error('no front') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(partition)
    await expect(held[0]?.ready()).rejects.toThrow(/no front/)

    failing = false
    sites.ensure(partition)
    await held[0]?.ready()
    expect(held).toHaveLength(1)
    expect(held[0]?.watched).toBe(1)
    expect(deps.controller.prepareSite).toHaveBeenCalledTimes(2)

    sites.ensure(partition)
    expect(deps.controller.prepareSite, 'a session that is ready is left alone').toHaveBeenCalledTimes(2)
  })
})

describe('removing a website\'s storage', () => {
  it('clears the cookies and storage and the cache of its session', async () => {
    const { sites, log } = setup()
    const partition = sitePartitionFor(SITE)
    await sites.removeStorage(partition)
    expect(log.sort()).toEqual([`clear ${partition}`, `clearCache ${partition}`])
  })
})
