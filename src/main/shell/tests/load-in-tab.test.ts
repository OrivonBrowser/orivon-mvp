import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provideVerifierAccess } from '../../verifier/verifier-access.js'

const repartitionView = vi.fn()
const loadURL = vi.fn(async () => {})
const partitionChanged = vi.fn<(target: string, current: string | undefined) => { to: string | undefined } | undefined>()
const appTabFlagChanged = vi.fn<() => boolean>()
vi.mock('../tab-parking.js', () => ({ repartitionView: (...args: unknown[]) => repartitionView(...args) }))
const dashboardView = { webContents: { loadURL, isDestroyed: () => false } }
vi.mock('../tab-partition.js', () => ({ partitionChanged: (target: string, current: string | undefined) => partitionChanged(target, current), appTabFlagChanged: () => appTabFlagChanged(), dashboardViews: new Set([dashboardView]) }))

const { gatewayLinkTarget, loadInTab, repartitionForTarget, stepOutOfView } = await import('../load-in-tab.js')
const { setLeavingRoutes } = await import('../../route/leaving-routes.js')

const record = (partition: string | undefined, redirect = true): never => ({ partition, view: { webContents: { loadURL } }, host: { broker: undefined, services: { settings: { get: () => redirect } } } }) as never

afterEach(() => { provideVerifierAccess({ start: () => {}, ready: async () => {} }) })

beforeEach(() => {
  provideVerifierAccess({ start: () => {}, ready: async () => {}, servesName: () => true })
  repartitionView.mockReset()
  loadURL.mockClear()
  partitionChanged.mockReset().mockReturnValue(undefined)
  appTabFlagChanged.mockReset().mockReturnValue(false)
})

describe('repartitionForTarget', () => {
  it('swaps to the target\'s session, which can itself be the default one', () => {
    partitionChanged.mockReturnValue({ to: undefined })
    const tab = record('persist:app')
    expect(repartitionForTarget('t1', tab, 'https://site.eth/')).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.eth/', undefined, false)
  })

  it('swaps within the session when only the app-tab flag differs', () => {
    appTabFlagChanged.mockReturnValue(true)
    const tab = record('persist:app')
    expect(repartitionForTarget('t1', tab, 'https://site.eth/')).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.eth/', 'persist:app', false)
  })

  it('does nothing when the session and the flag are the tab\'s', () => {
    expect(repartitionForTarget('t1', record(undefined), 'https://site.eth/')).toBe(false)
    expect(repartitionView).not.toHaveBeenCalled()
  })
})

describe('repartitionForTarget onto a page the person opened through their proxy', () => {
  const live = (partition: string): void => {
    setLeavingRoutes({
      world: { isRouted: () => true, isInstalledApp: () => false, routedOriginOf: () => undefined, servedOrigin: () => undefined },
      temporary: { open: async () => partition, owns: () => true, isLive: (name) => name === partition },
      routeSwitch: { blockedFor: () => undefined, choose: async () => {} }, kindOf: () => undefined, defaultKind: () => 'nym'
    })
  }
  afterEach(() => { setLeavingRoutes(undefined) })

  it('steps back into the temporary routed session while it is alive, never to the shared one', () => {
    live('orivon-route-tab-1')
    partitionChanged.mockReturnValue({ to: undefined })
    const tab = { ...(record('persist:app') as object), routedAway: 'orivon-route-tab-1' } as never
    expect(repartitionForTarget('t1', tab, 'https://site.example/', true)).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.example/', 'orivon-route-tab-1', true)
  })

  it('goes to the shared session once that session is gone, and for a typed address', () => {
    live('orivon-route-tab-2')
    partitionChanged.mockReturnValue({ to: undefined })
    const tab = { ...(record('persist:app') as object), routedAway: 'orivon-route-tab-1' } as never
    repartitionForTarget('t1', tab, 'https://site.example/', true)
    repartitionForTarget('t1', { ...(tab as object), routedAway: 'orivon-route-tab-2' } as never, 'https://site.example/')
    expect(repartitionView.mock.calls.map((call) => call[3])).toEqual([undefined, undefined])
  })
})

describe('stepOutOfView onto the new-tab page', () => {
  // An http:// address, as the dashboard has in dev mode: as a site it would ask for a session of its own.
  const DASHBOARD = 'http://127.0.0.1:5173/newtab/'
  const history = { getAllEntries: () => [{ url: 'https://a.example/', title: 'a' }], getActiveIndex: () => 0 }
  const tab = (view: object): never => ({ partition: 'persist:a', view, outer: { back: [{ url: DASHBOARD, title: '' }], forward: [] }, host: { dashboardUrl: DASHBOARD, emitState: vi.fn() } }) as never

  beforeEach(() => { partitionChanged.mockReturnValue({ to: 'persist:dev-server' }) })

  it('moves to a view of no session of its own, whatever the address looks like', () => {
    const moved = tab({ webContents: { loadURL, isDestroyed: () => false, navigationHistory: history } })
    expect(stepOutOfView('t1', moved, 'back')).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', moved, DASHBOARD, undefined, true)
  })

  it('loads in the tab\'s view when that is the view made for the page', () => {
    Object.assign(dashboardView.webContents, { navigationHistory: history })
    expect(stepOutOfView('t1', tab(dashboardView), 'back')).toBe(true)
    expect(repartitionView).not.toHaveBeenCalled()
    expect(loadURL).toHaveBeenCalledExactlyOnceWith(DASHBOARD)
  })
})

describe('loadInTab', () => {
  it('loads the address in the tab\'s own view when its session fits', () => {
    loadInTab('t1', record(undefined), 'https://site.eth/')
    expect(loadURL).toHaveBeenCalledExactlyOnceWith('https://site.eth/')
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('moves a tab in a cache-served app\'s session to the default one instead of loading there', () => {
    partitionChanged.mockReturnValue({ to: undefined })
    loadInTab('t1', record('persist:app'), 'https://site.eth/')
    expect(repartitionView).toHaveBeenCalledWith('t1', expect.anything(), 'https://site.eth/', undefined, false)
    expect(loadURL).not.toHaveBeenCalled()
  })
})

describe('gatewayLinkTarget', () => {
  it('leaves a link to a gateway address to the web-request redirect in a tab that need not move', () => {
    expect(gatewayLinkTarget(record(undefined), 'https://site.eth.limo/a#f')).toBeUndefined()
  })

  it('maps the link in a tab that must move to the .eth address\'s session', () => {
    partitionChanged.mockReturnValue({ to: undefined })
    expect(gatewayLinkTarget(record('persist:app'), 'https://site.eth.limo/a#f')).toBe('https://site.eth/a#f')
  })

  it('maps the link in a cache-served app\'s tab even when the .eth address shares its session', () => {
    expect(gatewayLinkTarget(record('persist:app'), 'https://app.eth.limo/x')).toBe('https://app.eth/x')
  })

  it('maps the link in a tab whose app-tab flag differs from the .eth address\'s', () => {
    appTabFlagChanged.mockReturnValue(true)
    expect(gatewayLinkTarget(record(undefined), 'https://site.eth.limo/')).toBe('https://site.eth/')
  })

  it('maps nothing when the setting is off, the address is no gateway one, or the name cannot load', () => {
    partitionChanged.mockReturnValue({ to: undefined })
    expect(gatewayLinkTarget(record('persist:app', false), 'https://site.eth.limo/')).toBeUndefined()
    expect(gatewayLinkTarget(record('persist:app'), 'https://example.com/')).toBeUndefined()
    provideVerifierAccess({ start: () => {}, ready: async () => {} })
    expect(gatewayLinkTarget(record('persist:app'), 'https://site.eth.limo/')).toBeUndefined()
  })
})
