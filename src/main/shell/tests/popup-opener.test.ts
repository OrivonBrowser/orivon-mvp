import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

// popup-opener.ts imports the serving registry, which the tab-view tests also stub.
const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: (origin: string) => served.has(origin) }))

const { keepsOpenerSession, openerCutNeeded } = await import('../popup-opener.js')
const { setSiteRoutes } = await import('../../route/site-routes.js')

const withOpener = { opener: {} } as unknown as WebContents
const alone = { opener: null } as unknown as WebContents
afterEach(() => { setSiteRoutes(undefined); served.clear() })

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

describe('openerCutNeeded', () => {
  const KEPT = 'https://kept.eth'
  const openedBy = (url: string): WebContents => ({ opener: { url } } as unknown as WebContents)
  const websitePage = (): boolean => false
  const appPage = (): boolean => true

  it('cuts a popup whose opener is a website page of the origin it now shows: the page the person allowed the site over keeps its same-origin link otherwise', () => {
    served.add(KEPT)
    expect(openerCutNeeded(openedBy(`${KEPT}/`), `${KEPT}/second.html`, undefined, websitePage)).toBe(true)
  })

  it('keeps the link between two pages of the app itself, and for a site the shell does not serve', () => {
    served.add(KEPT)
    expect(openerCutNeeded(openedBy(`${KEPT}/`), `${KEPT}/second.html`, undefined, appPage)).toBe(false)
    served.clear()
    expect(openerCutNeeded(openedBy(`${KEPT}/`), `${KEPT}/second.html`, undefined, websitePage)).toBe(false)
  })

  it('cuts a move into another origin that is an app, as before, and not a move between ordinary sites', () => {
    served.add('https://other-app.eth')
    expect(openerCutNeeded(openedBy('https://news.example/'), 'https://other-app.eth/', undefined, websitePage)).toBe(true)
    expect(openerCutNeeded(openedBy('https://news.example/'), 'https://elsewhere.example/', undefined, websitePage)).toBe(false)
  })

  it('has nothing to cut for a popup with no opener, or one whose opener is gone', () => {
    served.add(KEPT)
    expect(openerCutNeeded({ opener: null } as unknown as WebContents, `${KEPT}/`, undefined, websitePage)).toBe(false)
    const gone = { get opener (): never { throw new Error('Object has been destroyed') } } as unknown as WebContents
    expect(openerCutNeeded(gone, `${KEPT}/`, undefined, websitePage)).toBe(false)
  })
})
