import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))

const { setTabTunnelChoice } = await import('../tab-tunnel-choice.js')
const { setSiteRoutes, setSiteSessionEnsurer } = await import('../../route/site-routes.js')

const SITE = 'https://news.example'
const log = vi.spyOn(console, 'log').mockImplementation(() => {})
const error = vi.spyOn(console, 'error').mockImplementation(() => {})
const ensure = vi.fn()

interface Fake { record: Record<string, unknown>, emitState: ReturnType<typeof vi.fn> }

function fake (over: Record<string, unknown> = {}, url = `${SITE}/page`, closing = false): Fake {
  const emitState = vi.fn()
  const record = { view: { webContents: { isDestroyed: () => false, getURL: () => url, navigationHistory: { getAllEntries: () => [], getActiveIndex: () => 0 } } }, partition: undefined, isDashboardTab: false, internalPage: null, sleeping: null, host: { emitState, isClosing: () => closing }, ...over }
  return { record, emitState }
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

  it('takes the pages a new tab holds out of its view, so that Forward loads them in the session the choice calls for', () => {
    const removed: number[] = []
    const navigationHistory = {
      getAllEntries: () => [{ url: 'orivon-shell://renderer/newtab/index.html', title: '' }, { url: `${SITE}/a`, title: 'a' }, { url: `${SITE}/b`, title: 'b' }],
      getActiveIndex: () => 0,
      length: () => 3,
      removeEntryAtIndex: (index: number) => { removed.push(index) }
    }
    const { record } = fake({ isDashboardTab: true, view: { webContents: { isDestroyed: () => false, getURL: () => '', navigationHistory } } })
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(record['outer']).toMatchObject({ back: [], forward: [{ url: `${SITE}/a` }, { url: `${SITE}/b` }] })
    expect(removed).toEqual([2, 1])
    expect(repartitionView).not.toHaveBeenCalled()
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

  it('gives the choice back when the move cannot be made and nothing moved, so the tab never claims a tunnel its page is not using', () => {
    repartitionView.mockImplementationOnce(() => { throw new Error('no view') })
    const { record, emitState } = fake()
    setTabTunnelChoice('t1', record as never, 'nym')
    expect('tunnelChoice' in record).toBe(false)
    expect(error).toHaveBeenCalled()
    expect(emitState).toHaveBeenCalledTimes(1)
  })

  it('gives back a choice that was taken away when the move back cannot be made, so the page stays in the tunnel its tab names', () => {
    repartitionView.mockImplementationOnce(() => { throw new Error('no view') })
    const { record } = fake({ tunnelChoice: 'socks5', partition: 'persist:proxy-profile' })
    setTabTunnelChoice('t1', record as never, null)
    expect(record['tunnelChoice']).toBe('socks5')
  })

  it('keeps the choice and closes the view it left when the move stopped half-way, so no script of the page runs on in the session it was in', () => {
    const { record } = fake()
    const left = (record as { view: { webContents: { close: ReturnType<typeof vi.fn> } } }).view
    left.webContents.close = vi.fn()
    repartitionView.mockImplementationOnce((_id: string, moving: { view: unknown, partition: string }) => {
      moving.view = { webContents: { isDestroyed: () => false, close: vi.fn() } }
      moving.partition = 'persist:tunnel-profile'
      throw new Error('no attach')
    })
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(record['tunnelChoice']).toBe('nym')
    expect(left.webContents.close).toHaveBeenCalledTimes(1)
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

describe('giving a tab a tunnel choice in a window held to Nym', () => {
  beforeEach(() => { setSiteRoutes({ profileFor: () => undefined, heldTo: 'nym' }) })

  it.each(['direct', 'socks5'] as const)('refuses %s: the tab keeps what it had, nothing moves and no profile is readied', (choice) => {
    const { record, emitState } = fake()
    setTabTunnelChoice('t1', record as never, choice)
    expect('tunnelChoice' in record).toBe(false)
    expect(repartitionView).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(emitState).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('refuses the proxy for a tab that has Nym, which stays in Nym\'s profile', () => {
    const { record } = fake({ tunnelChoice: 'nym', partition: 'persist:tunnel-profile' })
    setTabTunnelChoice('t1', record as never, 'socks5')
    expect(record['tunnelChoice']).toBe('nym')
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('takes Nym, and takes it away', () => {
    const { record } = fake()
    setTabTunnelChoice('t1', record as never, 'nym')
    expect(record['tunnelChoice']).toBe('nym')
    expect(repartitionView).toHaveBeenCalledWith('t1', record, `${SITE}/page`, 'persist:tunnel-profile')
    setTabTunnelChoice('t1', record as never, null)
    expect('tunnelChoice' in record).toBe(false)
  })

  it('says why in the log, and never an address', () => {
    const { record } = fake({}, 'https://secret.example/private?token=1')
    setTabTunnelChoice('t1', record as never, 'direct')
    const said = [...log.mock.calls, ...error.mock.calls].map((call) => String(call[0])).join('\n')
    expect(said).toContain('held')
    expect(said).not.toContain('secret.example')
  })
})
