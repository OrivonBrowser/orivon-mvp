import { describe, expect, it, vi } from 'vitest'
import { isAppOrigin, isRegisteredAppOrigin } from '../app-origin.js'

const CACHED = 'https://cached.example'
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: (origin: string) => origin === CACHED }))

const ORIGIN = 'https://app.example'
const broker = (app: { hasGrantsSync: boolean, isRegisteredSync: boolean }): never =>
  ({ app: { hasGrantsSync: () => app.hasGrantsSync, isRegisteredSync: () => app.isRegisteredSync } }) as never

describe('isAppOrigin', () => {
  it('is false for an origin the broker registered but that holds no grants: a declined origin stays under the person\'s site rules', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: true }) }, ORIGIN)).toBe(false)
  })

  it('is false for an installed app that holds no grants: it is a website to the person\'s site rules', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: false }) }, CACHED)).toBe(false)
  })

  it('is true for an origin that holds grants', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: true, isRegisteredSync: false }) }, ORIGIN)).toBe(true)
  })

  it('is false for a website the broker knows nothing about, and with no broker yet', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: false }) }, ORIGIN)).toBe(false)
    expect(isAppOrigin({ broker: undefined }, ORIGIN)).toBe(false)
  })
})

describe('isRegisteredAppOrigin', () => {
  it('is true for an origin the broker registered, even with no grant', () => {
    expect(isRegisteredAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: true }) }, ORIGIN)).toBe(true)
  })

  it('is true for an installed app that holds no grants', () => {
    expect(isRegisteredAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: false }) }, CACHED)).toBe(true)
  })

  it('is true for an origin that holds grants, and false for a website and with no broker yet', () => {
    expect(isRegisteredAppOrigin({ broker: broker({ hasGrantsSync: true, isRegisteredSync: false }) }, ORIGIN)).toBe(true)
    expect(isRegisteredAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: false }) }, ORIGIN)).toBe(false)
    expect(isRegisteredAppOrigin({ broker: undefined }, ORIGIN)).toBe(false)
  })
})
