import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

// popup-opener.ts imports the serving registry, which the tab-view tests also stub.
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: () => false }))

const { keepsOpenerSession } = await import('../popup-opener.js')
const { setSiteRoutes } = await import('../../route/site-routes.js')

const withOpener = { opener: {} } as unknown as WebContents
const alone = { opener: null } as unknown as WebContents
afterEach(() => { setSiteRoutes(undefined) })

describe('keepsOpenerSession', () => {
  it('keeps a popup in its opener\'s session when it moves to the shared one and both send the address alike', () => {
    setSiteRoutes({ profileFor: () => undefined, sentLikeItsOwn: () => true })
    expect(keepsOpenerSession(withOpener, { to: undefined }, 'persist:direct-profile', 'https://news.example/')).toBe(true)
  })

  it('does not when the opener\'s session would send the address differently: the popup moves and its opener is cut', () => {
    setSiteRoutes({ profileFor: () => undefined, sentLikeItsOwn: () => false })
    expect(keepsOpenerSession(withOpener, { to: undefined }, 'persist:direct-profile', 'https://news.example/')).toBe(false)
  })

  it('does not for a popup with no opener, or a move into a session of its own', () => {
    expect(keepsOpenerSession(alone, { to: undefined }, 'persist:direct-profile', 'https://news.example/')).toBe(false)
    expect(keepsOpenerSession(withOpener, { to: 'persist:tunnel-profile' }, 'persist:direct-profile', 'https://news.example/')).toBe(false)
  })
})
