import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSiteSession, setSiteRoutes, setSiteSessionEnsurer, siteOriginOf, sitePartitionForOrigin } from '../site-routes.js'
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
