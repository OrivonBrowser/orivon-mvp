import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))

const { setTabTunnelChoice } = await import('../tab-tunnel-choice.js')
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
