import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSiteSession, mustLeaveSharedSession, setSiteRoutes, setSiteSessionEnsurer, siteOriginOf, sitePartitionForOrigin } from '../site-routes.js'
import { sitePartitionFor } from '../site-partition.js'

const SITE = 'https://news.example'
afterEach(() => { setSiteRoutes(undefined); setSiteSessionEnsurer(undefined) })

describe('the session a website must run in', () => {
  it('is the shared one until routes are running', () => {
    expect(sitePartitionForOrigin(SITE)).toBeUndefined()
  })

  it('is its own while its tunnel state differs from the default, and the shared one otherwise', () => {
    let own = false
    setSiteRoutes({ usesOwnSession: () => own })
    expect(sitePartitionForOrigin(SITE)).toBeUndefined()
    own = true
    expect(sitePartitionForOrigin(SITE)).toBe(sitePartitionFor(SITE))
  })

  it('is never its own for this computer, whatever the state says', () => {
    setSiteRoutes({ usesOwnSession: () => true })
    expect(sitePartitionForOrigin('http://localhost:3000')).toBeUndefined()
    expect(sitePartitionForOrigin('http://127.0.0.1:8080')).toBeUndefined()
  })

  it('remembers which origin a session name it handed out stands for, and no other', () => {
    setSiteRoutes({ usesOwnSession: () => true })
    const partition = sitePartitionForOrigin(SITE)
    expect(siteOriginOf(partition)).toBe(SITE)
    expect(siteOriginOf(sitePartitionFor('https://never-asked.example'))).toBeUndefined()
    expect(siteOriginOf('persist:app-abc')).toBeUndefined()
    expect(siteOriginOf(undefined)).toBeUndefined()
  })
})

describe('making a website\'s session ready before a view is made in it', () => {
  it('asks for a session of its own and for nothing else', () => {
    const ensure = vi.fn()
    setSiteSessionEnsurer(ensure)
    ensureSiteSession(sitePartitionFor(SITE))
    ensureSiteSession('persist:app-abc')
    ensureSiteSession('persist:orivon-local-files')
    expect(ensure.mock.calls).toEqual([[sitePartitionFor(SITE)]])
  })
})

describe('a load the shell\'s own move missed', () => {
  const cached = (): boolean => false

  it('is refused in the shared session for a website that has a session of its own, whatever the page of the address', () => {
    setSiteRoutes({ usesOwnSession: (origin) => origin === SITE })
    expect(mustLeaveSharedSession(`${SITE}/a?b=1#c`, cached)).toBe(true)
    expect(mustLeaveSharedSession('https://other.example/', cached)).toBe(false)
  })

  it('is let through while no website has one, for this computer, for an address with no origin and for an app served from the cache', () => {
    expect(mustLeaveSharedSession(`${SITE}/`, cached)).toBe(false)
    setSiteRoutes({ usesOwnSession: () => true })
    expect(mustLeaveSharedSession('http://localhost:3000/', cached)).toBe(false)
    expect(mustLeaveSharedSession('about:blank', cached)).toBe(false)
    expect(mustLeaveSharedSession(`${SITE}/`, () => true)).toBe(false)
  })
})
