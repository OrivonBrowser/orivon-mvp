import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSiteSession, mustLeaveSession, keepSiteApart, sessionRoutesLike, setSiteRoutes, setSiteSessionEnsurer, siteProfileOf, sitePartitionForOrigin, sitePartitionForTab } from '../site-routes.js'
import type { Profile } from '../site-partition.js'

const SITE = 'https://news.example'
afterEach(() => { setSiteRoutes(undefined); setSiteSessionEnsurer(undefined) })

describe('the session a website must run in', () => {
  it('is the shared one until routes are running', () => {
    expect(sitePartitionForOrigin(SITE)).toBeUndefined()
  })

  it('is the profile its entry names, and the shared one for a website with no entry', () => {
    let profile: Profile | undefined
    setSiteRoutes({ profileFor: () => profile })
    expect(sitePartitionForOrigin(SITE)).toBeUndefined()
    profile = 'nym'
    expect(sitePartitionForOrigin(SITE)).toBe('persist:tunnel-profile')
    profile = 'socks5'
    expect(sitePartitionForOrigin(SITE)).toBe('persist:proxy-profile')
    expect(sitePartitionForOrigin('http://news.example')).toBe('proxy-profile-memory')
    profile = 'direct'
    expect(sitePartitionForOrigin(SITE)).toBe('persist:direct-profile')
    expect(sitePartitionForOrigin('http://news.example')).toBe('direct-profile-memory')
  })

  it('is the same session for every website with that entry', () => {
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(sitePartitionForOrigin(SITE)).toBe(sitePartitionForOrigin('https://other.example'))
  })

  it('is never a profile for this computer, whatever the entry says', () => {
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(sitePartitionForOrigin('http://localhost:3000')).toBeUndefined()
    expect(sitePartitionForOrigin('http://127.0.0.1:8080')).toBeUndefined()
  })

  it('says which profile a session name stands for, and none for any other', () => {
    expect(siteProfileOf('persist:tunnel-profile')).toBe('nym')
    expect(siteProfileOf('persist:proxy-profile')).toBe('socks5')
    expect(siteProfileOf('direct-profile-memory')).toBe('direct')
    expect(siteProfileOf('persist:app-abc')).toBeUndefined()
    expect(siteProfileOf(undefined)).toBeUndefined()
  })
})

describe('the session a website must run in, in a tab with a tunnel choice', () => {
  it('is the website\'s own with no choice', () => {
    setSiteRoutes({ profileFor: () => 'socks5' })
    expect(sitePartitionForTab(SITE, undefined)).toBe(sitePartitionForOrigin(SITE))
  })

  it('is the tunnel\'s profile for a website with no entry, with an entry of off and with the other tunnel', () => {
    for (const own of [undefined, 'direct', 'socks5'] as const) {
      setSiteRoutes({ profileFor: () => own })
      expect(sitePartitionForTab(SITE, 'nym')).toBe('persist:tunnel-profile')
    }
    for (const own of [undefined, 'direct', 'nym'] as const) {
      setSiteRoutes({ profileFor: () => own })
      expect(sitePartitionForTab(SITE, 'socks5')).toBe('persist:proxy-profile')
    }
    expect(sitePartitionForTab('http://news.example', 'socks5')).toBe('proxy-profile-memory')
  })

  it('is the direct profile for a direct choice, unless the website has a tunnel of its own', () => {
    setSiteRoutes({ profileFor: () => undefined })
    expect(sitePartitionForTab(SITE, 'direct')).toBe('persist:direct-profile')
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(sitePartitionForTab(SITE, 'direct')).toBe('persist:tunnel-profile')
  })

  it('is the shared session for this computer whatever the choice, and until routes are running', () => {
    expect(sitePartitionForTab(SITE, 'nym')).toBeUndefined()
    setSiteRoutes({ profileFor: () => undefined })
    for (const choice of ['nym', 'socks5', 'direct'] as const) expect(sitePartitionForTab('http://localhost:3000', choice)).toBeUndefined()
  })
})

describe('recording that a tab\'s choice put a website in a profile', () => {
  it('is handed to routes, and is nothing before they run', () => {
    expect(() => { keepSiteApart(SITE, 'nym') }).not.toThrow()
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    keepSiteApart(SITE, 'socks5')
    expect(keep).toHaveBeenCalledWith(SITE, 'socks5')
  })
})

describe('making a profile session ready before a view is made in it', () => {
  it('asks for a profile session and for nothing else', () => {
    const ensure = vi.fn()
    setSiteSessionEnsurer(ensure)
    ensureSiteSession('persist:tunnel-profile')
    ensureSiteSession('persist:app-abc')
    ensureSiteSession('persist:orivon-local-files')
    expect(ensure.mock.calls).toEqual([['persist:tunnel-profile', true]])
    ensureSiteSession('persist:direct-profile', false)
    expect(ensure.mock.calls.at(-1)).toEqual(['persist:direct-profile', false])
  })
})

describe('a load the shell\'s own move missed', () => {
  const cached = (): boolean => false
  const shared = { shared: true, via: 'nym' as const, temporary: false }
  const direct = { shared: false, via: undefined, temporary: false }
  const tunnel = { shared: false, via: 'nym' as const, temporary: false }
  const held = { shared: false, via: 'held' as const, temporary: false }
  const routed = (origin: string): 'nym' | undefined => origin === SITE ? 'nym' : undefined

  it('is refused in the shared session for a website that has a profile, whatever the page of the address', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'nym' : undefined })
    expect(mustLeaveSession(`${SITE}/a?b=1#c`, shared, cached, routed)).toBe(true)
    expect(mustLeaveSession('https://other.example/', shared, cached, routed)).toBe(false)
  })

  it('is let through while no website has one, for this computer, for an address with no origin and for an app served from the cache', () => {
    expect(mustLeaveSession(`${SITE}/`, shared, cached, routed)).toBe(false)
    setSiteRoutes({ profileFor: () => 'direct' })
    expect(mustLeaveSession('http://localhost:3000/', shared, cached, () => 'nym')).toBe(false)
    expect(mustLeaveSession('about:blank', shared, cached, () => 'nym')).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, shared, () => true, routed)).toBe(false)
  })

  it('is refused in any session that is not tunnelled for a website that is, and let through for one that is not', () => {
    expect(mustLeaveSession(`${SITE}/`, direct, cached, routed)).toBe(true)
    expect(mustLeaveSession('https://other.example/', direct, cached, routed)).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, tunnel, cached, routed)).toBe(false)
  })

  it('is refused in a session that goes through the other tunnel, and let through in one that is stopped', () => {
    expect(mustLeaveSession(`${SITE}/`, { shared: false, via: 'socks5', temporary: false }, cached, routed)).toBe(true)
    expect(mustLeaveSession(`${SITE}/`, held, cached, routed)).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, tunnel, cached, (origin) => origin === SITE ? 'socks5' : undefined)).toBe(true)
  })

  it('is let through in a temporary session, where any website is opened on purpose', () => {
    expect(mustLeaveSession(`${SITE}/`, { ...direct, temporary: true }, cached, routed)).toBe(false)
  })

  it('never judges this computer by the tunnel', () => {
    expect(mustLeaveSession('http://127.0.0.1:8080/', direct, cached, () => 'nym')).toBe(false)
  })
})

describe('a load of a tab with a tunnel choice the shell\'s own move missed', () => {
  const cached = (): boolean => false
  const shared = { shared: true, via: undefined, temporary: false }
  const direct = { shared: false, via: undefined, temporary: false }
  const none = (): undefined => undefined

  it('is refused in the shared session for a website that follows no entry, and in any session that is not the tunnel\'s', () => {
    setSiteRoutes({ profileFor: () => undefined })
    expect(mustLeaveSession(`${SITE}/`, shared, cached, none, 'nym')).toBe(true)
    expect(mustLeaveSession(`${SITE}/`, direct, cached, none, 'socks5')).toBe(true)
    expect(mustLeaveSession(`${SITE}/`, { shared: false, via: 'nym', temporary: false }, cached, none, 'socks5')).toBe(true)
  })

  it('is let through in the session of the tab\'s own tunnel, even for a website whose entry is off or the other tunnel', () => {
    setSiteRoutes({ profileFor: () => 'direct' })
    expect(mustLeaveSession(`${SITE}/`, { shared: false, via: 'socks5', temporary: false }, cached, none, 'socks5')).toBe(false)
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(mustLeaveSession(`${SITE}/`, { shared: false, via: 'socks5', temporary: false }, cached, (origin) => origin === SITE ? 'nym' : undefined, 'socks5')).toBe(false)
  })

  it('is refused in the shared session for a direct choice, which puts the website in the direct profile, and let through there', () => {
    setSiteRoutes({ profileFor: () => undefined })
    expect(mustLeaveSession(`${SITE}/`, shared, cached, none, 'direct')).toBe(true)
    expect(mustLeaveSession(`${SITE}/`, direct, cached, none, 'direct')).toBe(false)
  })

  it('keeps a website\'s own tunnel in a direct tab: its session must go through that tunnel', () => {
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(mustLeaveSession(`${SITE}/`, direct, cached, (origin) => origin === SITE ? 'nym' : undefined, 'direct')).toBe(true)
    expect(mustLeaveSession(`${SITE}/`, { shared: false, via: 'nym', temporary: false }, cached, (origin) => origin === SITE ? 'nym' : undefined, 'direct')).toBe(false)
  })

  it('never judges this computer, an app served from the cache or a temporary session by the choice', () => {
    setSiteRoutes({ profileFor: () => undefined })
    expect(mustLeaveSession('http://127.0.0.1:8080/', direct, cached, none, 'nym')).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, shared, () => true, none, 'nym')).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, { ...direct, temporary: true }, cached, none, 'nym')).toBe(false)
  })

  it('judges a load with no choice as it always was', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'nym' : undefined })
    expect(mustLeaveSession(`${SITE}/`, shared, cached, none, undefined)).toBe(true)
    expect(mustLeaveSession('https://other.example/', shared, cached, none, undefined)).toBe(false)
  })
})

describe('whether a session sends a page as its own would', () => {
  it('is yes while nothing is known, and for an address the tunnel cannot carry', () => {
    expect(sessionRoutesLike('persist:direct-profile', `${SITE}/`)).toBe(true)
    setSiteRoutes({ profileFor: () => undefined, sentLikeItsOwn: () => false })
    expect(sessionRoutesLike('persist:direct-profile', 'http://localhost:3000/')).toBe(true)
    expect(sessionRoutesLike('persist:direct-profile', 'about:blank')).toBe(true)
  })

  it('asks what main knows for a web address', () => {
    const like = vi.fn(() => false)
    setSiteRoutes({ profileFor: () => undefined, sentLikeItsOwn: like })
    expect(sessionRoutesLike('persist:direct-profile', `${SITE}/page`)).toBe(false)
    expect(like).toHaveBeenCalledWith('persist:direct-profile', SITE)
  })
})
