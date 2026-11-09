import { afterEach, describe, expect, it, vi } from 'vitest'

const { served, pinned } = vi.hoisted(() => ({ served: new Set<string>(), pinned: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin),
  isOriginPinnedSync: (origin: string) => pinned.has(origin)
}))

const { appSessionPartition, hasOwnPartition, isWebsitePageOfApp, needsNoVerifierHost, runsAsWebsite } = await import('../app-session.js')
const { setSiteRoutes } = await import('../../route/site-routes.js')
const { partitionFor } = await import('../../../broker/grants/origin-hash.js')

const NAMED = 'https://kept.eth'
const ADDRESS = 'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon'
const PLAIN = 'https://app.example'
const LOOPBACK = 'http://127.0.0.1:8080'

afterEach(() => {
  served.clear()
  pinned.clear()
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

  it('is where websites run whatever tunnel entry the site has: its session is the profile of the entry, as a website\'s', () => {
    served.add(NAMED)
    setSiteRoutes({ profileFor: (origin) => origin === NAMED ? 'nym' : undefined })
    expect(runsAsWebsite(NAMED)).toBe(true)
    expect(hasOwnPartition(NAMED)).toBe(false)
    expect(appSessionPartition(NAMED)).toBeUndefined()
  })
})

describe('an origin that is no app', () => {
  it('runs as no app does, whatever the host', () => {
    expect(runsAsWebsite(NAMED)).toBe(false)
    expect(hasOwnPartition(NAMED)).toBe(false)
    expect(hasOwnPartition(PLAIN)).toBe(false)
  })
})

describe('which allowed apps keep the verifier host awake', () => {
  it('keeps it for an app that runs where websites run, pinned or not, since the host answers its requests', () => {
    served.add(NAMED)
    expect(needsNoVerifierHost(NAMED)).toBe(false)
    pinned.add(NAMED)
    expect(needsNoVerifierHost(NAMED)).toBe(false)
  })

  it('lets it sleep for an app in a partition of its own that is served from its pin, and keeps it for one still read live', () => {
    served.add(PLAIN)
    expect(needsNoVerifierHost(PLAIN)).toBe(false)
    pinned.add(PLAIN)
    expect(needsNoVerifierHost(PLAIN)).toBe(true)
  })
})

describe('a website\'s page that was open when its origin became an app', () => {
  it('is a page without the app-tab flag at an origin that runs where websites run', () => {
    served.add(NAMED)
    expect(isWebsitePageOfApp(`${NAMED}/page`, false)).toBe(true)
  })

  it('is not the page of a view that has the flag, nor a page at an origin the shell does not serve, nor a granted network page with a partition of its own', () => {
    served.add(NAMED)
    served.add(PLAIN)
    expect(isWebsitePageOfApp(`${NAMED}/page`, true)).toBe(false)
    expect(isWebsitePageOfApp('https://news.example/', false)).toBe(false)
    expect(isWebsitePageOfApp(`${PLAIN}/`, false)).toBe(false)
    expect(isWebsitePageOfApp('about:blank', false)).toBe(false)
  })
})
