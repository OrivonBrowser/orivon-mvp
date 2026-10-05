import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provideVerifierAccess } from '../../verifier/verifier-access.js'

const repartitionView = vi.fn()
const partitionChanged = vi.fn<(target: string, current: string | undefined) => { to: string | undefined } | undefined>()
const appTabFlagChanged = vi.fn<() => boolean>()
vi.mock('../tab-parking.js', () => ({ repartitionView: (...args: unknown[]) => repartitionView(...args) }))
vi.mock('../tab-partition.js', () => ({ partitionChanged: (target: string, current: string | undefined) => partitionChanged(target, current), appTabFlagChanged: () => appTabFlagChanged() }))

const { gatewayLinkTarget, loadInTab, repartitionForTarget } = await import('../load-in-tab.js')

const loadURL = vi.fn(async () => {})
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
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.eth/', undefined)
  })

  it('swaps within the session when only the app-tab flag differs', () => {
    appTabFlagChanged.mockReturnValue(true)
    const tab = record('persist:app')
    expect(repartitionForTarget('t1', tab, 'https://site.eth/')).toBe(true)
    expect(repartitionView).toHaveBeenCalledExactlyOnceWith('t1', tab, 'https://site.eth/', 'persist:app')
  })

  it('does nothing when the session and the flag are the tab\'s', () => {
    expect(repartitionForTarget('t1', record(undefined), 'https://site.eth/')).toBe(false)
    expect(repartitionView).not.toHaveBeenCalled()
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
    expect(repartitionView).toHaveBeenCalledWith('t1', expect.anything(), 'https://site.eth/', undefined)
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
