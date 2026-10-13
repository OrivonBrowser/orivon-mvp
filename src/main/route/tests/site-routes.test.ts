import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSiteSession, mustLeaveSharedSession, setSiteRoutes, setSiteSessionEnsurer, siteProfileOf, sitePartitionForOrigin } from '../site-routes.js'
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
    expect(ensure.mock.calls).toEqual([['persist:tunnel-profile']])
  })
})

describe('a load the shell\'s own move missed', () => {
  const cached = (): boolean => false

  it('is refused in the shared session for a website that has a profile, whatever the page of the address', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'tunnel' : undefined })
    expect(mustLeaveSharedSession(`${SITE}/a?b=1#c`, cached)).toBe(true)
    expect(mustLeaveSharedSession('https://other.example/', cached)).toBe(false)
  })

  it('is let through while no website has one, for this computer, for an address with no origin and for an app served from the cache', () => {
    expect(mustLeaveSharedSession(`${SITE}/`, cached)).toBe(false)
    setSiteRoutes({ profileFor: () => 'direct' })
    expect(mustLeaveSharedSession('http://localhost:3000/', cached)).toBe(false)
    expect(mustLeaveSharedSession('about:blank', cached)).toBe(false)
    expect(mustLeaveSharedSession(`${SITE}/`, () => true)).toBe(false)
  })
})
