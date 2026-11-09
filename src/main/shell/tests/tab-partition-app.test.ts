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

  it('follows the tunnel choice of the tab as a website does, for a host the verifier answers, and not for an app with a partition of its own', () => {
    served.add(NAMED)
    served.add(PLAIN)
    setSiteRoutes({ profileFor: () => undefined })
    expect(partitionForTab(`${NAMED}/`, 'nym')).toBe(profilePartitionFor('nym', NAMED))
    expect(partitionForTab(`${NAMED}/`, 'direct')).toBe(profilePartitionFor('direct', NAMED))
    expect(partitionForTab(`${NAMED}/`, undefined)).toBeUndefined()
    expect(partitionForTab(`${PLAIN}/`, 'nym')).toBe(partitionFor(PLAIN))
  })

  it('is the profile of the entry for an allowed app with a tunnel entry of its own, as for a website', () => {
    served.add(NAMED)
    setSiteRoutes({ profileFor: (origin) => origin === NAMED ? 'nym' : undefined })
    expect(partitionForTarget(`${NAMED}/`)).toBe(profilePartitionFor('nym', NAMED))
  })

  it('is the profile of the entry for a website at the same host that is not allowed', () => {
    setSiteRoutes({ profileFor: (origin) => origin === NAMED ? 'nym' : undefined })
    expect(partitionForTarget(`${NAMED}/`)).toBe(profilePartitionFor('nym', NAMED))
  })
})
