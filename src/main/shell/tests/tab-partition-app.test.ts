import { afterEach, describe, expect, it, vi } from 'vitest'

const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { partitionChanged, partitionForTab, partitionForTarget } = await import('../tab-partition.js')
const { setSiteRoutes } = await import('../../route/site-routes.js')
const { partitionFor } = await import('../../../broker/grants/origin-hash.js')
const { profilePartitionFor } = await import('../../route/site-partition.js')

const NAMED = 'https://kept.eth'
const PLAIN = 'https://app.example'
const LOOPBACK = 'http://127.0.0.1:8080'

afterEach(() => {
  served.clear()
  setSiteRoutes(undefined)
})

describe('the session a tab shows an allowed app in', () => {
  it('is the shared one for a host the verifier answers, as for a website at that host', () => {
    expect(partitionForTarget(`${NAMED}/a`)).toBeUndefined()
    served.add(NAMED)
    expect(partitionForTarget(`${NAMED}/a`)).toBeUndefined()
    expect(partitionChanged(`${NAMED}/`, undefined, undefined)).toBeUndefined()
  })

  it('is the app\'s own partition for an https host the verifier does not answer, and for loopback', () => {
    served.add(PLAIN)
    served.add(LOOPBACK)
    expect(partitionForTarget(`${PLAIN}/a`)).toBe(partitionFor(PLAIN))
    expect(partitionForTarget(`${LOOPBACK}/`)).toBe(partitionFor(LOOPBACK))
  })

  it('does not move the tab into the app when the app is allowed, only into the app tab flag', () => {
    expect(partitionChanged(`${NAMED}/`, undefined, undefined)).toBeUndefined()
    served.add(NAMED)
    expect(partitionChanged(`${NAMED}/`, undefined, undefined)).toBeUndefined()
  })

  it('moves a tab that sat in the app\'s old partition to the shared session', () => {
    served.add(NAMED)
    expect(partitionChanged(`${NAMED}/`, partitionFor(NAMED), undefined)).toEqual({ to: undefined })
  })

  it('is not changed by the tunnel choice of the tab: an app keeps the session of its own route', () => {
    served.add(NAMED)
    setSiteRoutes({ profileFor: () => undefined })
    expect(partitionForTab(`${NAMED}/`, 'nym')).toBeUndefined()
    expect(partitionForTab(`${NAMED}/`, 'direct')).toBeUndefined()
    expect(partitionForTab(`${PLAIN}/`, 'nym')).toBe(profilePartitionFor('nym', PLAIN))
  })

  it('is the app\'s own partition while the shared session would send the app differently from its own route', () => {
    served.add(NAMED)
    setSiteRoutes({ profileFor: () => undefined, sharedLikeItsOwn: () => false })
    expect(partitionForTarget(`${NAMED}/`)).toBe(partitionFor(NAMED))
  })

  it('is the profile of the entry for a website at the same host that is not allowed', () => {
    setSiteRoutes({ profileFor: (origin) => origin === NAMED ? 'nym' : undefined })
    expect(partitionForTarget(`${NAMED}/`)).toBe(profilePartitionFor('nym', NAMED))
  })
})
