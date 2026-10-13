import { describe, expect, it, vi } from 'vitest'
import { DIRECT_PROFILE_ORIGIN, TUNNEL_PROFILE_ORIGIN } from '../route-hub.js'
import { createSiteSessions } from '../site-sessions.js'
import type { SiteSession, SiteSessionsDeps } from '../site-sessions.js'

const TUNNEL = 'persist:tunnel-profile'
const DIRECT = 'persist:direct-profile'
const SITE = 'https://news.example'

function setup (prepare: () => Promise<void> = async () => {}) {
  const log: string[] = []
  const sessions = new Map<string, SiteSession>()
  const sessionFor = (partition: string): SiteSession => {
    let one = sessions.get(partition)
    if (one === undefined) {
      one = {
        setProxy: async () => {},
        closeAllConnections: async () => {},
        clearData: async (options) => { log.push(`clear ${partition} ${options.origins.join(',')}`) }
      }
      sessions.set(partition, one)
    }
    return one
  }
  const held: Array<{ session: SiteSession, ready: () => Promise<void>, watched: number }> = []
  const deps: SiteSessionsDeps = {
    controller: {
      prepareSite: vi.fn(async (identity: string, _session: object, bypass: string) => { log.push(`prepare ${identity} ${bypass}`); await prepare() }),
      confineSite: vi.fn(async () => { log.push('confine') })
    },
    sessionFor,
    bypass: () => '*.eth',
    hold: (session, ready) => { const one = { session, ready, watched: 0 }; held.push(one); return () => { one.watched += 1 } },
    fit: () => { log.push('fit') },
    extend: async () => { log.push('extend') }
  }
  return { sites: createSiteSessions(deps), deps, held, log }
}

describe('making a profile session ready', () => {
  it('prepares the tunnel profile under its own identity, with the verifier\'s names, then loads the extensions, and holds its requests until then', async () => {
    const { sites, held, log } = setup()

    sites.ensure(TUNNEL)

    expect(held).toHaveLength(1)
    await held[0]?.ready()
    expect(log).toEqual(['fit', `prepare ${TUNNEL_PROFILE_ORIGIN} *.eth`, 'extend'])
  })

  it('prepares the direct profile under the identity that is never routed', async () => {
    const { sites, held, log } = setup()
    sites.ensure(DIRECT)
    await held[0]?.ready()
    expect(log).toContain(`prepare ${DIRECT_PROFILE_ORIGIN} *.eth`)
  })

  it('does it once for a session, however many views are made in it', () => {
    const { sites, held, deps } = setup()

    sites.ensure(TUNNEL)
    sites.ensure(TUNNEL)

    expect(held).toHaveLength(1)
    expect(deps.controller.prepareSite).toHaveBeenCalledTimes(1)
  })

  it('confines a session that could not be pointed, and keeps refusing its requests', async () => {
    const { sites, held, log } = setup(async () => { throw new Error('no front') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(TUNNEL)

    await expect(held[0]?.ready()).rejects.toThrow(/no front/)
    expect(log).toContain('confine')
    expect(log, 'no extension runs in a session that is refused').not.toContain('extend')
  })

  it('refuses everything in a session that is not a profile\'s', async () => {
    const { sites, held, deps } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure('persist:site-abc')

    expect(deps.controller.prepareSite).not.toHaveBeenCalled()
    await expect(held[0]?.ready()).rejects.toThrow()
  })
})

describe('a session that could not be made ready', () => {
  it('is tried again the next time a view is made in it, and its hold is told to look again', async () => {
    let failing = true
    const { sites, held, deps } = setup(async () => { if (failing) throw new Error('no front') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(TUNNEL)
    await expect(held[0]?.ready()).rejects.toThrow(/no front/)

    failing = false
    sites.ensure(TUNNEL)
    await held[0]?.ready()
    expect(held).toHaveLength(1)
    expect(held[0]?.watched).toBe(1)
    expect(deps.controller.prepareSite).toHaveBeenCalledTimes(2)

    sites.ensure(TUNNEL)
    expect(deps.controller.prepareSite, 'a session that is ready is left alone').toHaveBeenCalledTimes(2)
  })
})

describe('removing a website\'s storage', () => {
  it('clears that website\'s data from the profile and no other website\'s', async () => {
    const { sites, log } = setup()
    await sites.removeStorage(TUNNEL, SITE)
    expect(log).toEqual([`clear ${TUNNEL} ${SITE}`])
  })
})
