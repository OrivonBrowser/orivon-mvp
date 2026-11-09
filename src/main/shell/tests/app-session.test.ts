import { afterEach, describe, expect, it, vi } from 'vitest'

const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { appSessionPartition, hasOwnPartition, runsAsWebsite } = await import('../app-session.js')
const { setSiteRoutes } = await import('../../route/site-routes.js')
const { partitionFor } = await import('../../../broker/grants/origin-hash.js')

const NAMED = 'https://kept.eth'
const ADDRESS = 'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon'
const PLAIN = 'https://app.example'
const LOOPBACK = 'http://127.0.0.1:8080'

afterEach(() => {
  served.clear()
  setSiteRoutes(undefined)
})

describe('where an app served from a copy Orivon keeps runs', () => {
  it.each([NAMED, ADDRESS])('is where websites run, for %s, a host the verifier answers', (origin) => {
    served.add(origin)
    expect(runsAsWebsite(origin)).toBe(true)
    expect(hasOwnPartition(origin)).toBe(false)
    expect(appSessionPartition(origin)).toBeUndefined()
  })

  it.each([PLAIN, LOOPBACK, 'https://kept.eth:8443'])('is a partition of its own, for %s, a host the verifier does not answer', (origin) => {
    served.add(origin)
    expect(runsAsWebsite(origin)).toBe(false)
    expect(hasOwnPartition(origin)).toBe(true)
    expect(appSessionPartition(origin)).toBe(partitionFor(origin))
  })

  it('is a partition of its own while the shared session would send the app differently from its own route', () => {
    served.add(NAMED)
    setSiteRoutes({ profileFor: () => undefined, sharedLikeItsOwn: (origin) => origin !== NAMED })
    expect(runsAsWebsite(NAMED)).toBe(false)
    expect(hasOwnPartition(NAMED)).toBe(true)
    expect(appSessionPartition(NAMED)).toBe(partitionFor(NAMED))
  })

  it('follows the route as it changes', () => {
    served.add(NAMED)
    let like = true
    setSiteRoutes({ profileFor: () => undefined, sharedLikeItsOwn: () => like })
    expect(appSessionPartition(NAMED)).toBeUndefined()
    like = false
    expect(appSessionPartition(NAMED)).toBe(partitionFor(NAMED))
  })
})

describe('an origin that is no app', () => {
  it('runs as no app does, whatever the host', () => {
    expect(runsAsWebsite(NAMED)).toBe(false)
    expect(hasOwnPartition(NAMED)).toBe(false)
    expect(hasOwnPartition(PLAIN)).toBe(false)
  })
})
