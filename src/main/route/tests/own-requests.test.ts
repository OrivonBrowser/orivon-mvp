import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownDirectSession, ownFetch, ownFetchForTab, ownRequestsSettled, ownRequestsTunnelled, ownRouteFor, ownSiteSession, setOwnRequests } from '../own-requests.js'

const ordinary = vi.fn(async () => new Response('ordinary'))
const tunnel = vi.fn(async () => new Response('tunnel'))
const direct = vi.fn(async () => new Response('direct'))
const SESSION = { name: 'system' }

function world (everywhere: boolean, off: readonly string[] = []): void {
  setOwnRequests({ everywhere: () => everywhere, isRouted: (origin) => !off.includes(origin), tunnel, direct, directSession: () => SESSION })
}
afterEach(() => { setOwnRequests(undefined); vi.clearAllMocks() })

describe('how Orivon\'s own requests leave', () => {
  it('as they always did while the whole browser is not on the tunnel, and before routes are running', async () => {
    expect(await (await ownFetch(ordinary)('https://api.example/x')).text()).toBe('ordinary')
    world(false)
    expect(await (await ownFetch(ordinary)('https://api.example/x')).text()).toBe('ordinary')
    expect(ownRequestsTunnelled()).toBe(false)
    expect(ownRouteFor('https://app.example')).toBe('ordinary')
    expect(ownDirectSession()).toBeUndefined()
    expect(tunnel).not.toHaveBeenCalled()
  })

  it('through the tunnel while it is on, with the request and its init passed on', async () => {
    world(true)
    const init = { method: 'POST', body: 'x' }
    expect(await (await ownFetch(ordinary)('https://stats.example/v1', init)).text()).toBe('tunnel')
    expect(tunnel).toHaveBeenCalledWith('https://stats.example/v1', init)
    expect(ordinary).not.toHaveBeenCalled()
    expect(ownRequestsTunnelled()).toBe(true)
  })

  it('on the system\'s proxy for an origin set to off, and through the tunnel for any other', async () => {
    world(true, ['https://off.example'])
    expect(await (await ownFetch(ordinary, 'https://off.example')('https://off.example/manifest')).text()).toBe('direct')
    expect(await (await ownFetch(ordinary, 'https://on.example')('https://on.example/manifest')).text()).toBe('tunnel')
    expect(ownRouteFor('https://off.example')).toBe('direct')
    expect(ownRouteFor('https://on.example')).toBe('tunnel')
    expect(ownRouteFor()).toBe('tunnel')
    expect(ownDirectSession()).toBe(SESSION)
  })

  it('reads the setting again for every request, so a flip applies to the next one', async () => {
    let on = false
    setOwnRequests({ everywhere: () => on, isRouted: () => true, tunnel, direct, directSession: () => SESSION })
    const fetch = ownFetch(ordinary)
    expect(await (await fetch('https://a.example')).text()).toBe('ordinary')
    on = true
    expect(await (await fetch('https://a.example')).text()).toBe('tunnel')
  })
})

describe('a request about an origin that is routed on its own, with the whole browser off the tunnel', () => {
  const profile = vi.fn(async () => new Response('through its route'))

  it('goes through that origin\'s route, and an origin with none keeps the ordinary way', async () => {
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel, direct, directSession: () => SESSION, through: async (origin) => origin === 'https://routed.eth' ? profile : undefined })
    expect(await (await ownFetch(ordinary, 'https://routed.eth')('https://routed.eth/.well-known/orivon.json')).text()).toBe('through its route')
    expect(profile).toHaveBeenCalledWith('https://routed.eth/.well-known/orivon.json', undefined)
    expect(await (await ownFetch(ordinary, 'https://plain.example')('https://plain.example/x')).text()).toBe('ordinary')
    expect(await (await ownFetch(ordinary)('https://api.example/x')).text()).toBe('ordinary')
  })

  it('is not made at all when the route cannot be had, and never falls back to the ordinary way', async () => {
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel, direct, directSession: () => SESSION, through: async () => { throw new Error('the tunnel profile could not be made ready') } })
    await expect(ownFetch(ordinary, 'https://routed.eth')('https://routed.eth/x')).rejects.toThrow(/could not be made ready/)
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('gives a caller that makes its own requests the session of the website, and none for any other origin', async () => {
    const PROFILE = { name: 'tunnel-profile' }
    const siteSession = async (origin: string): Promise<object | undefined> => origin === 'https://routed.eth' ? PROFILE : undefined
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel, direct, directSession: () => SESSION, siteSession })
    expect(await ownSiteSession('https://routed.eth')).toBe(PROFILE)
    expect(await ownSiteSession('https://plain.example')).toBeUndefined()
    setOwnRequests(undefined)
    expect(await ownSiteSession('https://routed.eth')).toBeUndefined()
  })
})

describe('a request about a website with a tunnel of its own, with the whole browser on a tunnel', () => {
  const profile = vi.fn(async () => new Response('through its own tunnel'))
  const PROFILE = { name: 'proxy-profile' }

  it('goes through the website\'s own tunnel, not the default one that may be another', async () => {
    setOwnRequests({ everywhere: () => true, isRouted: () => true, tunnel, direct, directSession: () => SESSION, through: async (origin) => origin === 'https://picked.example' ? profile : undefined })
    expect(await (await ownFetch(ordinary, 'https://picked.example')('https://picked.example/.well-known/orivon.json')).text()).toBe('through its own tunnel')
    expect(tunnel).not.toHaveBeenCalled()
    expect(await (await ownFetch(ordinary, 'https://follows.example')('https://follows.example/x')).text()).toBe('tunnel')
    expect(await (await ownFetch(ordinary)('https://api.example/x')).text()).toBe('tunnel')
  })

  it('is not made at all when its tunnel cannot be had, and never falls back to the default one', async () => {
    setOwnRequests({ everywhere: () => true, isRouted: () => true, tunnel, direct, directSession: () => SESSION, through: async () => { throw new Error('the tunnel profile could not be made ready') } })
    await expect(ownFetch(ordinary, 'https://picked.example')('https://picked.example/x')).rejects.toThrow(/could not be made ready/)
    expect(tunnel).not.toHaveBeenCalled()
  })

  it('gives a caller that makes its own requests the session of the website', async () => {
    setOwnRequests({ everywhere: () => true, isRouted: () => true, tunnel, direct, directSession: () => SESSION, siteSession: async (origin) => origin === 'https://picked.example' ? PROFILE : undefined })
    expect(await ownSiteSession('https://picked.example')).toBe(PROFILE)
    expect(await ownSiteSession('https://follows.example')).toBeUndefined()
  })
})

describe('where the name of a website with a tunnel of its own is looked up', () => {
  const tunnelled = (everywhere: boolean): void => {
    setOwnRequests({ everywhere: () => everywhere, isRouted: () => true, tunnel, direct, directSession: () => SESSION, siteTunnelled: (origin) => origin === 'https://picked.example' })
  }

  it('at the far end of its tunnel, with the whole browser off the tunnel too', () => {
    tunnelled(false)
    expect(ownRouteFor('https://picked.example')).toBe('tunnel')
    expect(ownRouteFor('https://plain.example')).toBe('ordinary')
    tunnelled(true)
    expect(ownRouteFor('https://picked.example')).toBe('tunnel')
  })
})

describe('a request made for a tab with a tunnel choice, about no website', () => {
  const profileFetch = vi.fn((kind: string) => async () => new Response(`profile ${kind}`))
  function tabWorld (everywhere = false, withProfile = true): void {
    setOwnRequests({ everywhere: () => everywhere, isRouted: () => true, tunnel, direct, directSession: () => SESSION, ...(withProfile ? { profileFetch } : {}) })
  }

  it('is made in the tunnel\'s profile session, whatever the whole browser is set to', async () => {
    for (const everywhere of [false, true]) {
      tabWorld(everywhere)
      expect(await (await ownFetchForTab(ordinary, 'nym')('https://suggest.example/?q=a')).text()).toBe('profile nym')
      expect(await (await ownFetchForTab(ordinary, 'socks5')('https://suggest.example/?q=a')).text()).toBe('profile socks5')
    }
    expect(ordinary).not.toHaveBeenCalled()
    expect(tunnel).not.toHaveBeenCalled()
  })

  it('is not made at all when there is no profile session to make it in, and never falls back to the ordinary way', async () => {
    tabWorld(false, false)
    await expect(ownFetchForTab(ordinary, 'nym')('https://suggest.example/?q=a')).rejects.toThrow(/tunnel/)
    setOwnRequests(undefined)
    await expect(ownFetchForTab(ordinary, 'socks5')('https://suggest.example/?q=a')).rejects.toThrow(/tunnel/)
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('is the ordinary own request for a tab with no tunnel choice, or a direct one', async () => {
    tabWorld(true)
    expect(await (await ownFetchForTab(ordinary, undefined)('https://suggest.example/?q=a')).text()).toBe('tunnel')
    tabWorld(false)
    expect(await (await ownFetchForTab(ordinary, undefined)('https://suggest.example/?q=a')).text()).toBe('ordinary')
    expect(profileFetch).not.toHaveBeenCalled()
  })
})

describe('while the sessions are still following a change of the setting', () => {
  it('waits for them before deciding how to leave, and reads the setting after the wait', async () => {
    let on = false
    let done!: () => void
    const pending = new Promise<void>((resolve) => { done = resolve })
    setOwnRequests({ everywhere: () => on, isRouted: () => true, tunnel, direct, directSession: () => SESSION, settled: async () => { await pending } })
    const answer = ownFetch(ordinary)('https://a.example')
    on = true
    await Promise.resolve()
    expect(tunnel).not.toHaveBeenCalled()
    done()
    expect(await (await answer).text()).toBe('tunnel')
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('refuses when they do not follow in time, in either direction, and sends nothing', async () => {
    setOwnRequests({ everywhere: () => true, isRouted: () => true, tunnel, direct, directSession: () => SESSION, settled: async () => { await new Promise<void>(() => {}) }, settleMs: 20 })
    await expect(ownFetch(ordinary)('https://a.example')).rejects.toThrow('still being applied')
    await expect(ownRequestsSettled()).rejects.toThrow('still being applied')
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel, direct, directSession: () => SESSION, settled: async () => { await new Promise<void>(() => {}) }, settleMs: 20 })
    await expect(ownFetch(ordinary)('https://a.example')).rejects.toThrow('still being applied')
    expect(ordinary).not.toHaveBeenCalled()
    expect(tunnel).not.toHaveBeenCalled()
  })
})
