import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import type { TunnelCallbacks } from '../site-info/tunnel-view.js'
import type { TunnelRowModel } from '../site-info/tunnels-model.js'

let callbacks: TunnelCallbacks
let rows: readonly TunnelRowModel[] = []
vi.mock('../site-info/tunnel-view.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../site-info/tunnel-view.js')>(),
  renderTunnelsPage: (_container: unknown, _info: unknown, model: { rows: readonly TunnelRowModel[] }, _view: unknown, given: TunnelCallbacks) => { callbacks = given; rows = model.rows }
}))

const { createTunnelsPage } = await import('../site-info/tunnels-page.js')

const tunnel: SiteTunnel = { via: null, following: true, subject: 'site', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym', proxy: { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, everything: false } } }
const infoWith = (patch: Partial<SiteTunnel> = {}): SiteInfo => ({
  origin: 'https://example.com', displayOrigin: 'example.com', claimedName: undefined, homeDomain: undefined, update: undefined, asked: true,
  capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [], tunnel: { ...tunnel, ...patch }
})

function setup (initial: SiteInfo) {
  let info = initial
  const bridge = {
    setTunnel: vi.fn(async (kind: 'nym' | 'socks5' | null) => ({ ok: true, info: infoWith({ via: kind }) })),
    setProxyAddress: vi.fn(async (text: string) => ({ ok: true, info: infoWith({ proxy: { ...tunnel.proxy, address: text } }) }) as { ok: boolean, reason?: 'invalid' | 'refused', info: SiteInfo }),
    testTunnel: vi.fn(async (): Promise<unknown> => ({ ok: true, authentication: 'none' })),
    openTunnelSettings: vi.fn(async () => {})
  }
  const redraw = vi.fn(() => { page.render({ querySelector: () => null } as unknown as HTMLElement, info) })
  const page = createTunnelsPage({ bridge, getInfo: () => info, setInfo: (next) => { info = next }, redraw })
  page.render({ querySelector: () => null } as unknown as HTMLElement, info)
  const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }
  return { bridge, redraw, flush, page, info: () => info }
}

beforeEach(() => { rows = [] })

describe('the switches', () => {
  it('send the site through the tunnel whose switch was turned on, and through none when the lit one is turned off', async () => {
    const { bridge, flush } = setup(infoWith())
    callbacks.onToggle('nym', true)
    await flush()
    expect(bridge.setTunnel).toHaveBeenLastCalledWith('nym')
    callbacks.onToggle('nym', false)
    await flush()
    expect(bridge.setTunnel).toHaveBeenLastCalledWith(null)
  })

  it('asks the storage question first for a first move into a profile, applies nothing until Confirm, and nothing at all on Cancel', async () => {
    const { bridge, flush } = setup(infoWith({ notices: { socks5: 'socks5' } }))
    callbacks.onToggle('socks5', true)
    await flush()
    expect(bridge.setTunnel).not.toHaveBeenCalled()
    expect(rows.find((row) => row.kind.id === 'socks5')?.on, 'the switch shows the move while the question is open').toBe(true)
    callbacks.onCancel()
    await flush()
    expect(bridge.setTunnel).not.toHaveBeenCalled()
    expect(rows.find((row) => row.kind.id === 'socks5')?.on).toBe(false)
    callbacks.onToggle('socks5', true)
    callbacks.onConfirm()
    await flush()
    expect(bridge.setTunnel).toHaveBeenCalledWith('socks5')
  })

  it('does nothing to a site when the switches are moved back to where they were while the question is open', async () => {
    const { bridge, flush } = setup(infoWith({ notices: { socks5: 'socks5' } }))
    callbacks.onToggle('socks5', true)
    callbacks.onToggle('socks5', false)
    await flush()
    expect(bridge.setTunnel).not.toHaveBeenCalled()
    expect(rows.every((row) => !row.on)).toBe(true)
  })
})

describe('the address of the proxy', () => {
  it('is asked for by the proxy\'s switch when none is saved, and saving it is what turns the proxy on', async () => {
    const { bridge, flush } = setup(infoWith({ proxy: { ...tunnel.proxy, address: '' }, blocked: { socks5: 'no-proxy' } }))
    callbacks.onToggle('socks5', true)
    await flush()
    expect(bridge.setTunnel, 'nothing is chosen before there is an address').not.toHaveBeenCalled()
    callbacks.onAddressInput('127.0.0.1:9050')
    callbacks.onSaveAddress('127.0.0.1:9050')
    await flush()
    expect(bridge.setProxyAddress).toHaveBeenCalledWith('127.0.0.1:9050')
    expect(bridge.setTunnel).toHaveBeenCalledWith('socks5')
  })

  it('keeps the field open with the words of Settings when the address is not one, and sends nothing on', async () => {
    const { bridge, flush } = setup(infoWith({ proxy: { ...tunnel.proxy, address: '' } }))
    bridge.setProxyAddress.mockResolvedValueOnce({ ok: false, reason: 'invalid', info: infoWith({ proxy: { ...tunnel.proxy, address: '' } }) })
    callbacks.onAddressInput('nonsense')
    callbacks.onSaveAddress('nonsense')
    await flush()
    const address = rows.find((row) => row.kind.id === 'socks5')?.address
    expect(address).toMatchObject({ editing: true, text: 'nonsense', error: 'Enter an address as host:port, like 127.0.0.1:9050' })
    expect(bridge.setTunnel).not.toHaveBeenCalled()
  })

  it('saves a change with nobody on the proxy at once, and puts the field away', async () => {
    const { bridge, flush } = setup(infoWith())
    callbacks.onChangeAddress()
    await flush()
    expect(rows.find((row) => row.kind.id === 'socks5')?.address?.editing).toBe(true)
    callbacks.onSaveAddress('127.0.0.1:9150')
    await flush()
    expect(bridge.setProxyAddress).toHaveBeenCalledWith('127.0.0.1:9150')
    expect(rows.find((row) => row.kind.id === 'socks5')?.address).toMatchObject({ editing: false, saved: '127.0.0.1:9150' })
  })

  it('asks first, naming how many, when sites or apps go through the proxy, and saves only on Confirm', async () => {
    const { bridge, flush } = setup(infoWith({ proxy: { address: '127.0.0.1:9050', users: { sites: 2, apps: 1, everything: false } } }))
    callbacks.onChangeAddress()
    callbacks.onSaveAddress('127.0.0.1:9150')
    await flush()
    expect(bridge.setProxyAddress).not.toHaveBeenCalled()
    expect(rows.find((row) => row.kind.id === 'socks5')?.address?.confirm).toContain('2 sites and 1 app')
    callbacks.onCancelAddress()
    await flush()
    expect(bridge.setProxyAddress).not.toHaveBeenCalled()
    callbacks.onChangeAddress()
    callbacks.onSaveAddress('127.0.0.1:9150')
    callbacks.onConfirmAddress()
    await flush()
    expect(bridge.setProxyAddress).toHaveBeenCalledWith('127.0.0.1:9150')
  })

  it('does not ask, or save, when the address typed is the one saved', async () => {
    const { bridge, flush } = setup(infoWith({ proxy: { address: '127.0.0.1:9050', users: { sites: 2, apps: 0, everything: false } } }))
    callbacks.onChangeAddress()
    callbacks.onSaveAddress(' 127.0.0.1:9050 ')
    await flush()
    expect(bridge.setProxyAddress).not.toHaveBeenCalled()
    expect(rows.find((row) => row.kind.id === 'socks5')?.address?.editing).toBe(false)
  })
})

describe('the Test', () => {
  it('shows it under way, then what main found, on the row it was pressed on', async () => {
    const { bridge, flush } = setup(infoWith())
    callbacks.onTest('socks5')
    expect(rows.find((row) => row.kind.id === 'socks5')?.testLine?.busy).toBe(true)
    await flush()
    expect(bridge.testTunnel).toHaveBeenCalledWith('socks5')
    expect(rows.find((row) => row.kind.id === 'socks5')?.testLine).toMatchObject({ text: 'The tunnel answered.', busy: false })
  })

  it('reads an answer that is not main\'s as nothing answering, never as a tunnel that works', async () => {
    const { bridge, flush } = setup(infoWith())
    bridge.testTunnel.mockResolvedValueOnce('yes')
    callbacks.onTest('socks5')
    await flush()
    expect(rows.find((row) => row.kind.id === 'socks5')?.testLine).toMatchObject({ down: true })
  })

  it('shows nothing when main answered nothing, as a window held to Nym does', async () => {
    const { bridge, flush } = setup(infoWith())
    bridge.testTunnel.mockResolvedValueOnce(null)
    callbacks.onTest('nym')
    await flush()
    expect(rows.find((row) => row.kind.id === 'nym')?.testLine).toBeNull()
  })
})
