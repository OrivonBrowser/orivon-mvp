import { describe, expect, it } from 'vitest'
import { isAppOrigin } from '../app-origin.js'

const ORIGIN = 'https://app.example'
const broker = (app: { hasGrantsSync: boolean, isRegisteredSync: boolean }): never =>
  ({ app: { hasGrantsSync: () => app.hasGrantsSync, isRegisteredSync: () => app.isRegisteredSync } }) as never

describe('isAppOrigin', () => {
  it('is true for an origin the broker registered, even with no grant', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: true }) }, ORIGIN)).toBe(true)
  })

  it('is true for an origin that holds grants', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: true, isRegisteredSync: false }) }, ORIGIN)).toBe(true)
  })

  it('is false for a website the broker knows nothing about, and with no broker yet', () => {
    expect(isAppOrigin({ broker: broker({ hasGrantsSync: false, isRegisteredSync: false }) }, ORIGIN)).toBe(false)
    expect(isAppOrigin({ broker: undefined }, ORIGIN)).toBe(false)
  })
})
