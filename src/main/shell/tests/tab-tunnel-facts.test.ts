import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kindShowing, noteTabVisit, tabChoiceCounts, tabsWithChoice } from '../tab-tunnel-facts.js'
import { setSiteRoutes } from '../../route/site-routes.js'

const SITE = 'https://news.example'
const error = vi.spyOn(console, 'error').mockImplementation(() => {})

function visit (over: Record<string, unknown>): never {
  return { partition: undefined, ...over } as never
}

beforeEach(() => { setSiteRoutes({ profileFor: () => undefined }) })
afterEach(() => {
  setSiteRoutes(undefined)
  vi.clearAllMocks()
})

describe('the storage a tab with a choice leaves in a profile', () => {
  it('is recorded for the website the tab committed, in the profile the tab is in', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(visit({ tunnelChoice: 'socks5', partition: 'persist:proxy-profile' }), `${SITE}/a?b=1`)
    expect(keep).toHaveBeenCalledWith(SITE, 'socks5')
  })

  it('is nothing for an origin the profile keeps in its memory twin: it is gone at restart and has no storage on disk to remove', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(visit({ tunnelChoice: 'nym', partition: 'tunnel-profile-memory' }), 'http://news.example/')
    expect(keep).not.toHaveBeenCalled()
  })

  it('does not throw when the record cannot be saved, and says so without the address', () => {
    const keep = vi.fn(() => { throw new Error('The choice could not be saved.') })
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    expect(() => { noteTabVisit(visit({ tunnelChoice: 'nym', partition: 'persist:tunnel-profile' }), 'https://secret.example/private?token=1') }).not.toThrow()
    expect(keep).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    for (const call of error.mock.calls) expect(call.map(String).join(' ')).not.toMatch(/secret|token|https?:/)
  })

  it('is nothing for a tab with no choice, whose websites are recorded by the switch that put them there', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(visit({ partition: 'persist:proxy-profile' }), `${SITE}/`)
    expect(keep).not.toHaveBeenCalled()
  })

  it('is nothing for a page outside a profile: this computer, a shell page, an app\'s own session', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(visit({ tunnelChoice: 'nym', partition: undefined }), 'http://127.0.0.1:8080/')
    noteTabVisit(visit({ tunnelChoice: 'nym', partition: 'persist:app-abc' }), `${SITE}/`)
    noteTabVisit(visit({ tunnelChoice: 'nym', partition: 'persist:tunnel-profile' }), 'about:blank')
    expect(keep).not.toHaveBeenCalled()
  })
})

describe('what the routes ask of the tabs', () => {
  const shown = (choice: 'nym' | 'socks5' | 'direct' | undefined, url: string, inflightUrl?: string) => ({ choice, url, inflightUrl })

  it('names the tunnel of a tab with a tunnel choice that shows the website, or is loading it', () => {
    expect(kindShowing([shown('nym', `${SITE}/a`)], SITE)).toBe('nym')
    expect(kindShowing([shown('socks5', 'https://other.example/', `${SITE}/b`)], SITE)).toBe('socks5')
  })

  it('names nothing for a direct tab, a tab with no choice and a tab on another website', () => {
    expect(kindShowing([shown('direct', `${SITE}/a`), shown(undefined, `${SITE}/a`), shown('nym', 'https://other.example/')], SITE)).toBeUndefined()
    expect(kindShowing([], SITE)).toBeUndefined()
  })

  it('names the first tab that shows it when two tabs have different choices', () => {
    expect(kindShowing([shown('socks5', `${SITE}/a`), shown('nym', `${SITE}/b`)], SITE)).toBe('socks5')
  })

  it('names nothing for an installed app, which keeps its own route whatever the tab shows it in', () => {
    const tabs = [shown('nym', `${SITE}/a`)]
    expect(kindShowing(tabs, SITE, (origin) => origin === SITE)).toBeUndefined()
    expect(kindShowing(tabs, SITE, (origin) => origin === 'https://app.example')).toBe('nym')
  })

  function windowsWith (...tabs: Array<{ id: string, choice?: 'nym' | 'socks5' | 'direct', url?: string, inflight?: string }>): never {
    const records = new Map(tabs.map((tab) => [tab.id, { ...(tab.choice === undefined ? {} : { tunnelChoice: tab.choice }), ...(tab.inflight === undefined ? {} : { inflightUrl: tab.inflight }) }]))
    const live = new Map(tabs.map((tab) => [tab.id, { getURL: () => tab.url ?? '' }]))
    const entry = { window: { isDestroyed: () => false }, tabs: { ids: () => [...records.keys()], record: (id: string) => records.get(id), liveWebContents: (id: string) => live.get(id) } }
    const gone = { window: { isDestroyed: () => true }, tabs: { ids: () => ['x'], record: () => ({ tunnelChoice: 'nym' }), liveWebContents: () => undefined } }
    return { all: () => [entry, gone] } as never
  }

  it('lists only the tabs that carry a choice, with what they show', () => {
    const windows = windowsWith({ id: 'a', choice: 'nym', url: `${SITE}/a` }, { id: 'b', url: 'https://plain.example/' }, { id: 'c', choice: 'direct', url: '', inflight: `${SITE}/c` })
    expect([...tabsWithChoice(windows)]).toEqual([{ choice: 'nym', url: `${SITE}/a`, inflightUrl: undefined }, { choice: 'direct', url: '', inflightUrl: `${SITE}/c` }])
  })

  it('counts the choices, as numbers and nothing else', () => {
    const windows = windowsWith({ id: 'a', choice: 'nym' }, { id: 'b', choice: 'nym' }, { id: 'c', choice: 'socks5' }, { id: 'd' })
    expect(tabChoiceCounts(windows)).toEqual({ nym: 2, socks5: 1, direct: 0 })
    expect(tabChoiceCounts({ all: () => [] })).toEqual({ nym: 0, socks5: 0, direct: 0 })
  })
})
