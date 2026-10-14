import { describe, expect, it, vi } from 'vitest'
import { DIRECT_PROFILE_ORIGIN, TUNNEL_PROFILE_ORIGIN } from '../route-hub.js'
import { createSiteSessions } from '../site-sessions.js'
import type { SiteSession, SiteSessionsDeps } from '../site-sessions.js'

const TUNNEL = 'persist:tunnel-profile'
const DIRECT = 'persist:direct-profile'
const SITE = 'https://news.example'

function setup (prepare: () => Promise<void> = async () => {}, wake: (session: SiteSession) => Promise<void> | undefined = () => undefined) {
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
    prepare: (_session, persistable) => { log.push(`prepare-extensions ${String(persistable)}`) },
    wake: (session) => { log.push('wake'); return wake(session) }
  }
  return { sites: createSiteSessions(deps), deps, held, log }
}

describe('the sessions made in this run', () => {
  it('names a profile session once a view or a lookup made it ready, and none before', () => {
    const { sites } = setup()
    expect(sites.made()).toEqual([])
    sites.ensure('tunnel-profile-memory', true)
    sites.ensure(TUNNEL, false)
    sites.ensure(TUNNEL, true)
    expect(sites.made()).toEqual(['tunnel-profile-memory', TUNNEL])
  })
})

describe('making a profile session ready', () => {
  it('prepares the tunnel profile under its own identity, with the verifier\'s names, then loads the extensions, and holds its requests until then', async () => {
    const { sites, held, log } = setup()

    sites.ensure(TUNNEL, true)

    expect(held).toHaveLength(1)
    await held[0]?.ready()
    expect(log).toEqual(['fit', 'prepare-extensions true', `prepare ${TUNNEL_PROFILE_ORIGIN} *.eth`, 'wake'])
  })

  it('tells the extension step when the profile is kept in memory, where Electron cannot load an extension but the request rules still apply', async () => {
    const { sites, held, log } = setup()
    sites.ensure('tunnel-profile-memory', true)
    await held[0]?.ready()
    expect(log).toEqual(['fit', 'prepare-extensions false', `prepare ${TUNNEL_PROFILE_ORIGIN} *.eth`, 'wake'])
  })

  it('prepares the direct profile under the identity that is never routed', async () => {
    const { sites, held, log } = setup()
    sites.ensure(DIRECT, true)
    await held[0]?.ready()
    expect(log).toContain(`prepare ${DIRECT_PROFILE_ORIGIN} *.eth`)
  })

  it('does it once for a session, however many views are made in it', () => {
    const { sites, held, deps } = setup()

    sites.ensure(TUNNEL, true)
    sites.ensure(TUNNEL, true)

    expect(held).toHaveLength(1)
    expect(deps.controller.prepareSite).toHaveBeenCalledTimes(1)
  })

  it('confines a session that could not be pointed, and keeps refusing its requests', async () => {
    const { sites, held, log } = setup(async () => { throw new Error('no front') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(TUNNEL, true)

    await expect(held[0]?.ready()).rejects.toThrow(/no front/)
    expect(log).toContain('confine')
    expect(log.filter((line) => line === 'wake'), 'no extension runs in a session that is refused').toEqual([])
  })

  it('refuses everything in a session that is not a profile\'s', async () => {
    const { sites, held, deps } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure('persist:site-abc', true)

    expect(deps.controller.prepareSite).not.toHaveBeenCalled()
    await expect(held[0]?.ready()).rejects.toThrow()
  })
})

describe('a session that could not be made ready', () => {
  it('is tried again the next time a view is made in it, and its hold is told to look again', async () => {
    let failing = true
    const { sites, held, deps } = setup(async () => { if (failing) throw new Error('no front') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(TUNNEL, true)
    await expect(held[0]?.ready()).rejects.toThrow(/no front/)

    failing = false
    sites.ensure(TUNNEL, true)
    await held[0]?.ready()
    expect(held).toHaveLength(1)
    expect(held[0]?.watched).toBe(1)
    expect(deps.controller.prepareSite).toHaveBeenCalledTimes(2)

    sites.ensure(TUNNEL, true)
    expect(deps.controller.prepareSite, 'a session that is ready is left alone').toHaveBeenCalledTimes(2)
  })
})

describe('the extensions of a session that is ready', () => {
  it('are asked for before each view; the requests of the session are held again only while they have to come back', async () => {
    let coming: (() => void) | undefined
    let answer: () => Promise<void> | undefined = () => undefined
    const { sites, held, log } = setup(async () => {}, () => answer())
    sites.ensure(DIRECT, true)
    await held[0]?.ready()
    expect(held[0]?.watched, 'a session whose extensions are on is not held again').toBe(0)

    sites.ensure(DIRECT, true)
    expect(log.filter((line) => line === 'wake'), 'asked again for the second view').toHaveLength(2)
    expect(held[0]?.watched).toBe(0)

    answer = () => new Promise<void>((resolve) => { coming = resolve })
    sites.ensure(DIRECT, true)
    expect(held[0]?.watched, 'the hold looks again while the extensions come back').toBe(1)
    let settled = false
    void held[0]?.ready().then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    coming?.()
    await held[0]?.ready()
    await Promise.resolve()
    expect(settled).toBe(true)
  })
})

describe('removing a website\'s storage', () => {
  it('clears that website\'s data from the profile and no other website\'s', async () => {
    const { sites, log } = setup()
    await sites.removeStorage(TUNNEL, SITE)
    expect(log).toEqual([`clear ${TUNNEL} ${SITE}`])
  })
})

describe('a view made in a session whose first attempt has not ended', () => {
  it('leaves the attempt to wake the extensions, and a failing attempt is retried at the next view', async () => {
    let fail = true
    let release: () => void = () => {}
    const { sites, held, deps, log } = setup(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      if (fail) throw new Error('no front')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    sites.ensure(TUNNEL, true)
    sites.ensure(TUNNEL, true)
    expect(log.filter((line) => line === 'wake'), 'no wake before the route is held').toEqual([])
    release()
    await expect(held[0]?.ready()).rejects.toThrow(/no front/)

    fail = false
    sites.ensure(TUNNEL, true)
    expect(deps.controller.prepareSite, 'a failed attempt is tried again').toHaveBeenCalledTimes(2)
    release()
    await held[0]?.ready()
  })
})

describe('a request made in a session with no view (a lookup)', () => {
  it('holds the session on its route and loads no extension, before or after it is ready', async () => {
    const { sites, held, log } = setup()

    sites.ensure(TUNNEL, false)
    await held[0]?.ready()
    sites.ensure(TUNNEL, false)
    await held[0]?.ready()

    expect(log).toEqual(['fit', 'prepare-extensions true', `prepare ${TUNNEL_PROFILE_ORIGIN} *.eth`, 'prepare-extensions true'])
  })

  it('leaves the extensions to a view that arrives while the session is still being made, and to the next view after', async () => {
    let release: () => void = () => {}
    const { sites, held, log } = setup(async () => { await new Promise<void>((resolve) => { release = resolve }) })

    sites.ensure(TUNNEL, false)
    sites.ensure(TUNNEL, true)
    release()
    await held[0]?.ready()
    expect(log.filter((line) => line === 'wake')).toHaveLength(1)

    sites.ensure(TUNNEL, true)
    expect(log.filter((line) => line === 'wake')).toHaveLength(2)
  })
})
