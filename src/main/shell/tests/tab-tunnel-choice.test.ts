import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))

const { kindShowing, noteTabVisit, setTabTunnelChoice, tabChoiceCounts, tabsWithChoice } = await import('../tab-tunnel-choice.js')
const { setSiteRoutes, setSiteSessionEnsurer } = await import('../../route/site-routes.js')

const SITE = 'https://news.example'
const log = vi.spyOn(console, 'log').mockImplementation(() => {})
const error = vi.spyOn(console, 'error').mockImplementation(() => {})
const ensure = vi.fn()

interface Fake { record: Record<string, unknown>, emitState: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn> }

function fake (over: Record<string, unknown> = {}, url = `${SITE}/page`, closing = false): Fake {
  const emitState = vi.fn()
  const stop = vi.fn()
  const record = { view: { webContents: { isDestroyed: () => false, getURL: () => url, stop } }, partition: undefined, isDashboardTab: false, internalPage: null, sleeping: null, host: { emitState, isClosing: () => closing }, ...over }
  return { record, emitState, stop }
}

beforeEach(() => {
  setSiteRoutes({ profileFor: () => undefined })
  setSiteSessionEnsurer(ensure)
})
afterEach(() => {
  setSiteRoutes(undefined)
  setSiteSessionEnsurer(undefined)
  vi.clearAllMocks()
})

describe('giving a tab a tunnel choice', () => {
  it('records it on the tab, readies the profile it calls for without waking extensions, and tells the strip', () => {
    const { record, emitState } = fake({}, 'orivon://newtab/')
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(record['tunnelChoice']).toBe('nym')
    expect(ensure).toHaveBeenCalledWith('persist:tunnel-profile', false)
    expect(emitState).toHaveBeenCalledTimes(1)
  })

  it('moves the website the tab shows into the session the choice calls for, and reloads it there', () => {
    const { record } = fake()
    setTabTunnelChoice('t1', record as never, 'socks5')
    expect(repartitionView).toHaveBeenCalledWith('t1', record, `${SITE}/page`, 'persist:proxy-profile')
  })

  it('moves it back to the session its own entry calls for when the choice is taken away', () => {
    const { record } = fake({ tunnelChoice: 'socks5', partition: 'persist:proxy-profile' })
    setTabTunnelChoice('t1', record as never, null)
    expect('tunnelChoice' in record).toBe(false)
    expect(repartitionView).toHaveBeenCalledWith('t1', record, `${SITE}/page`, undefined)
  })

  it('leaves a website where it is when the choice does not change its session', () => {
    const { record } = fake({ partition: 'persist:proxy-profile' })
    setTabTunnelChoice('t1', record as never, 'socks5')
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('does nothing for the same choice again', () => {
    const { record, emitState } = fake({ tunnelChoice: 'nym', partition: 'persist:tunnel-profile' })
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(emitState).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['the new-tab page', { isDashboardTab: true }],
    ['a page of the shell', { internalPage: 'settings' }],
    ['a tab asleep', { sleeping: { url: SITE, entries: [], index: 0 } }]
  ])('keeps the choice for %s without moving anything: its first address or its wake follows it', (_name, over) => {
    const { record, emitState } = fake(over)
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(record['tunnelChoice']).toBe('nym')
    expect(repartitionView).not.toHaveBeenCalled()
    expect(emitState).toHaveBeenCalled()
  })

  it('keeps the choice for a tab that is closing without moving it', () => {
    const { record } = fake({}, `${SITE}/page`, true)
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('stops the page\'s loads when the move cannot be made, so it is never left in the session it was in', () => {
    repartitionView.mockImplementationOnce(() => { throw new Error('no view') })
    const { record, stop } = fake()
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(stop).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('says the tunnel and the tab in the log, and never an address', () => {
    const { record } = fake({}, 'https://secret.example/private?token=1')
    setTabTunnelChoice('t1', record as never, 'nym')
    setTabTunnelChoice('t1', record as never, null)
    const said = log.mock.calls.map((call) => String(call[0]))
    expect(said).toEqual(['[route] tab tunnel chosen: nym (t1)', '[route] tab tunnel cleared (t1)'])
    for (const line of [...said, ...error.mock.calls.map((call) => String(call[0]))]) expect(line).not.toMatch(/secret|token|https?:/)
  })
})

describe('the storage a tab with a choice leaves in a profile', () => {
  it('is recorded for the website the tab committed, in the profile the tab is in', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(fake({ tunnelChoice: 'socks5', partition: 'persist:proxy-profile' }).record as never, `${SITE}/a?b=1`)
    expect(keep).toHaveBeenCalledWith(SITE, 'socks5')
  })

  it('is recorded in the profile\'s memory twin for an origin that may not be written to disk', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(fake({ tunnelChoice: 'nym', partition: 'tunnel-profile-memory' }).record as never, 'http://news.example/')
    expect(keep).toHaveBeenCalledWith('http://news.example', 'nym')
  })

  it('is nothing for a tab with no choice, whose websites are recorded by the switch that put them there', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(fake({ partition: 'persist:proxy-profile' }).record as never, `${SITE}/`)
    expect(keep).not.toHaveBeenCalled()
  })

  it('is nothing for a page outside a profile: this computer, a shell page, an app\'s own session', () => {
    const keep = vi.fn()
    setSiteRoutes({ profileFor: () => undefined, keepApart: keep })
    noteTabVisit(fake({ tunnelChoice: 'nym', partition: undefined }).record as never, 'http://127.0.0.1:8080/')
    noteTabVisit(fake({ tunnelChoice: 'nym', partition: 'persist:app-abc' }).record as never, `${SITE}/`)
    noteTabVisit(fake({ tunnelChoice: 'nym', partition: 'persist:tunnel-profile' }).record as never, 'about:blank')
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
