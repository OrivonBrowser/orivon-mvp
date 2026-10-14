import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSiteSession, mustLeaveSession, sessionRoutesLike, setSiteRoutes, setSiteSessionEnsurer, siteProfileOf, sitePartitionForOrigin } from '../site-routes.js'
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
    profile = 'tunnel'
    expect(sitePartitionForOrigin(SITE)).toBe('persist:tunnel-profile')
    profile = 'direct'
    expect(sitePartitionForOrigin(SITE)).toBe('persist:direct-profile')
    expect(sitePartitionForOrigin('http://news.example')).toBe('direct-profile-memory')
  })

  it('is the same session for every website with that entry', () => {
    setSiteRoutes({ profileFor: () => 'tunnel' })
    expect(sitePartitionForOrigin(SITE)).toBe(sitePartitionForOrigin('https://other.example'))
  })

  it('is never a profile for this computer, whatever the entry says', () => {
    setSiteRoutes({ profileFor: () => 'tunnel' })
    expect(sitePartitionForOrigin('http://localhost:3000')).toBeUndefined()
    expect(sitePartitionForOrigin('http://127.0.0.1:8080')).toBeUndefined()
  })

  it('says which profile a session name stands for, and none for any other', () => {
    expect(siteProfileOf('persist:tunnel-profile')).toBe('tunnel')
    expect(siteProfileOf('direct-profile-memory')).toBe('direct')
    expect(siteProfileOf('persist:app-abc')).toBeUndefined()
    expect(siteProfileOf(undefined)).toBeUndefined()
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
  const shared = { shared: true, tunnelled: true, temporary: false }
  const direct = { shared: false, tunnelled: false, temporary: false }
  const tunnel = { shared: false, tunnelled: true, temporary: false }
  const routed = (origin: string): boolean => origin === SITE

  it('is refused in the shared session for a website that has a profile, whatever the page of the address', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'tunnel' : undefined })
    expect(mustLeaveSession(`${SITE}/a?b=1#c`, shared, cached, routed)).toBe(true)
    expect(mustLeaveSession('https://other.example/', shared, cached, routed)).toBe(false)
  })

  it('is let through while no website has one, for this computer, for an address with no origin and for an app served from the cache', () => {
    expect(mustLeaveSession(`${SITE}/`, shared, cached, routed)).toBe(false)
    setSiteRoutes({ profileFor: () => 'direct' })
    expect(mustLeaveSession('http://localhost:3000/', shared, cached, () => true)).toBe(false)
    expect(mustLeaveSession('about:blank', shared, cached, () => true)).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, shared, () => true, routed)).toBe(false)
  })

  it('is refused in any session that is not tunnelled for a website that is, and let through for one that is not', () => {
    expect(mustLeaveSession(`${SITE}/`, direct, cached, routed)).toBe(true)
    expect(mustLeaveSession('https://other.example/', direct, cached, routed)).toBe(false)
    expect(mustLeaveSession(`${SITE}/`, tunnel, cached, routed)).toBe(false)
  })

  it('is let through in a temporary session, where any website is opened on purpose', () => {
    expect(mustLeaveSession(`${SITE}/`, { ...direct, temporary: true }, cached, routed)).toBe(false)
  })

  it('never judges this computer by the tunnel', () => {
    expect(mustLeaveSession('http://127.0.0.1:8080/', direct, cached, () => true)).toBe(false)
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
