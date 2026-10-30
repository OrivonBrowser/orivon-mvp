import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTunnel, SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import type { TunnelCallbacks, TunnelViewState } from '../site-info/tunnel-view.js'
import type { TunnelListModel, TunnelRowModel } from '../site-info/tunnels-model.js'

let callbacks: TunnelCallbacks
let rows: readonly TunnelRowModel[] = []
let shown: TunnelListModel
let shownView: TunnelViewState
vi.mock('../site-info/tunnel-view.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../site-info/tunnel-view.js')>(),
  renderTunnelsPage: (_container: unknown, _info: unknown, model: TunnelListModel, view: TunnelViewState, given: TunnelCallbacks) => { callbacks = given; rows = model.rows; shown = model; shownView = view }
}))

const { createTunnelsPage } = await import('../site-info/tunnels-page.js')

const tunnel: SiteTunnel = { via: null, following: true, subject: 'site', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym', proxy: { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, everything: false } } }
const browser: BrowserTunnel = { via: null, defaultKind: 'nym', nodes: false, blocked: {}, proxy: tunnel.proxy, unreadable: false, tabs: [] }
const infoWith = (patch: Partial<SiteTunnel> = {}, rest: Partial<SiteInfo> = {}): SiteInfo => ({
  origin: 'https://example.com', displayOrigin: 'example.com', claimedName: undefined, homeDomain: undefined, update: undefined, asked: true,
  capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [], tunnel: { ...tunnel, ...patch }, browserTunnel: browser, ...rest
})
/** The popup of a website while the whole browser is on `via` (null: on none), with `patch` for the browser's facts. */
const browserInfo = (patch: Partial<BrowserTunnel> = {}, rest: Partial<SiteInfo> = {}): SiteInfo => infoWith({}, { everywhere: patch.via !== undefined && patch.via !== null, browserTunnel: { ...browser, ...patch }, ...rest })

function setup (initial: SiteInfo) {
  let info = initial
  const bridge = {
    setTunnel: vi.fn(async (kind: 'nym' | 'socks5' | null) => ({ ok: true, info: infoWith({ via: kind }) })),
    setProxyAddress: vi.fn(async (text: string) => ({ ok: true, info: infoWith({ proxy: { ...tunnel.proxy, address: text } }) }) as { ok: boolean, reason?: 'invalid' | 'refused', info: SiteInfo }),
    testTunnel: vi.fn(async (): Promise<unknown> => ({ ok: true, authentication: 'none' })),
    setBrowserTunnel: vi.fn(async (kind: 'nym' | 'socks5' | null) => ({ ok: true, info: browserInfo({ via: kind }) })),
    setNodesTunnel: vi.fn(async (on: boolean) => ({ ok: true, info: browserInfo({ via: 'nym', nodes: on }) })),
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

describe('the switches of a tab', () => {
  it('are taken at once, with no storage question, and the lit one turned off asks for none', async () => {
    const { bridge, flush } = setup(infoWith({ subject: 'tab', via: 'nym', following: false, tabChoice: 'nym' }))
    expect(rows.find((row) => row.kind.id === 'nym')?.on).toBe(true)
    callbacks.onToggle('socks5', true)
    await flush()
    expect(bridge.setTunnel).toHaveBeenLastCalledWith('socks5')
    callbacks.onToggle('socks5', false)
    await flush()
    expect(bridge.setTunnel).toHaveBeenLastCalledWith(null)
  })
})

describe('which panel is drawn', () => {
  it('opens on the first panel for a page that is not on the browser\'s tunnel, and on Browser-wide when it follows one', () => {
    setup(infoWith())
    expect(shownView.panel).toBe('first')
    setup(browserInfo({ via: 'nym' }))
    expect(shownView.panel).toBe('browser')
    expect(rows.find((row) => row.kind.id === 'nym')?.on, 'the rows are the browser\'s').toBe(true)
  })

  it('opens on the first panel for a page with a choice of its own while the browser is on a tunnel', () => {
    setup(browserInfo({ via: 'nym' }, { tunnel: { ...tunnel, following: false, via: 'socks5' } }))
    expect(shownView.panel).toBe('first')
    expect(rows.find((row) => row.kind.id === 'socks5')?.on).toBe(true)
  })

  it('shows the panel the person clicked, and holds it while the popup is open, whatever the facts become', async () => {
    const { bridge, flush } = setup(infoWith())
    callbacks.onPanel('browser')
    await flush()
    expect(shownView.panel).toBe('browser')
    callbacks.onToggle('nym', true)
    await flush()
    expect(bridge.setBrowserTunnel).toHaveBeenCalledWith('nym')
    expect(shownView.panel, 'the browser is on a tunnel now, and the panel stays where the person put it').toBe('browser')
    callbacks.onPanel('first')
    await flush()
    expect(shownView.panel).toBe('first')
    expect(rows.find((row) => row.kind.id === 'nym')?.on, 'the first panel is the page\'s own, not the browser\'s').toBe(false)
  })

  it('draws no panels at all while routes are not running', () => {
    const { browserTunnel: _omitted, ...bare } = infoWith()
    setup(bare)
    expect(shownView.panels).toBeNull()
  })

  it('names the two panels', () => {
    setup(infoWith())
    expect(shownView.panels).toEqual({ first: 'This site', browser: 'Browser-wide' })
  })
})

describe('the first panel is unchanged by the second', () => {
  it('still sets the website\'s own tunnel, and never the browser\'s', async () => {
    const { bridge, flush } = setup(infoWith())
    callbacks.onToggle('nym', true)
    await flush()
    expect(bridge.setTunnel).toHaveBeenCalledWith('nym')
    expect(bridge.setBrowserTunnel).not.toHaveBeenCalled()
  })
})

describe('the switches of Browser-wide', () => {
  it('set the tunnel browser-wide when no tab keeps a choice of its own, and turn it off when the lit one is turned off, asking nothing', async () => {
    const { bridge, flush } = setup(browserInfo({ via: null }))
    callbacks.onPanel('browser')
    callbacks.onToggle('socks5', true)
    await flush()
    expect(bridge.setBrowserTunnel).toHaveBeenLastCalledWith('socks5')
    expect(shown.prompt).toBeNull()
    callbacks.onToggle('nym', false)
    await flush()
    expect(bridge.setBrowserTunnel).toHaveBeenLastCalledWith(null)
    expect(bridge.setTunnel).not.toHaveBeenCalled()
  })

  it('ask first when a tab keeps its own tunnel, set nothing until Proceed, and nothing at all on Cancel', async () => {
    const tabs: BrowserTunnel['tabs'] = [{ title: 'News', choice: 'nym' }]
    const { bridge, flush } = setup(browserInfo({ via: null, tabs }))
    callbacks.onPanel('browser')
    callbacks.onToggle('socks5', true)
    await flush()
    expect(bridge.setBrowserTunnel).not.toHaveBeenCalled()
    expect(shown.prompt?.tabs).toEqual([{ title: 'News', kept: 'Nym' }])
    expect(rows.find((row) => row.kind.id === 'socks5')?.on, 'the switch shows the move while the prompt is open').toBe(true)
    callbacks.onCancel()
    await flush()
    expect(bridge.setBrowserTunnel).not.toHaveBeenCalled()
    expect(shown.prompt).toBeNull()
    expect(rows.find((row) => row.kind.id === 'socks5')?.on).toBe(false)
    callbacks.onToggle('socks5', true)
    callbacks.onConfirm()
    await flush()
    expect(bridge.setBrowserTunnel).toHaveBeenCalledWith('socks5')
    expect(shown.prompt).toBeNull()
  })

  it('ask the same question again, never one for the first panel, when Proceed on the drawn prompt is pressed twice', async () => {
    const { bridge, flush } = setup(browserInfo({ via: null, tabs: [{ title: 'News', choice: 'nym' }] }))
    callbacks.onPanel('browser')
    callbacks.onToggle('socks5', true)
    await flush()
    const proceed = callbacks.onConfirm
    proceed()
    proceed()
    await flush()
    expect(bridge.setBrowserTunnel.mock.calls).toEqual([['socks5'], ['socks5']])
    expect(bridge.setTunnel).not.toHaveBeenCalled()
  })

  it('drop the question, and the move it was about, when the last tab that kept its own tunnel is gone by the next drawing', async () => {
    const { flush } = setup(browserInfo({ via: 'nym', tabs: [{ title: 'News', choice: 'direct' }] }))
    callbacks.onPanel('browser')
    callbacks.onToggle('socks5', true)
    await flush()
    expect(shown.prompt).not.toBeNull()
    callbacks.onNodes(true)
    await flush()
    expect(shown.prompt).toBeNull()
    expect(rows.map((row) => [row.kind.id, row.on])).toEqual([['nym', true], ['socks5', false]])
  })

  it('ask again when the tunnel that is on browser-wide is changed to the other, and not when it is turned off', async () => {
    const tabs: BrowserTunnel['tabs'] = [{ title: 'Bank', choice: 'direct' }]
    const { bridge, flush } = setup(browserInfo({ via: 'nym', tabs }))
    callbacks.onPanel('browser')
    callbacks.onToggle('socks5', true)
    await flush()
    expect(shown.prompt).not.toBeNull()
    expect(bridge.setBrowserTunnel).not.toHaveBeenCalled()
    callbacks.onToggle('socks5', false)
    await flush()
    expect(shown.prompt, 'the switches moved back to where they were').toBeNull()
    callbacks.onToggle('nym', false)
    await flush()
    expect(bridge.setBrowserTunnel).toHaveBeenLastCalledWith(null)
  })

  it('close an open prompt when the person goes to the other panel, without setting anything', async () => {
    const { bridge, flush } = setup(browserInfo({ via: null, tabs: [{ title: 'News', choice: 'nym' }] }))
    callbacks.onPanel('browser')
    callbacks.onToggle('nym', true)
    await flush()
    expect(shown.prompt).not.toBeNull()
    callbacks.onPanel('first')
    await flush()
    callbacks.onPanel('browser')
    await flush()
    expect(shown.prompt).toBeNull()
    expect(bridge.setBrowserTunnel).not.toHaveBeenCalled()
  })

  it('ask for the proxy\'s address when none is saved, and saving it is what sets the proxy browser-wide, after the prompt if one is due', async () => {
    const noAddress = { ...tunnel.proxy, address: '' }
    const tabs: BrowserTunnel['tabs'] = [{ title: 'News', choice: 'nym' }]
    const { bridge, flush } = setup(browserInfo({ via: null, proxy: noAddress, blocked: { socks5: 'no-proxy' }, tabs }))
    bridge.setProxyAddress.mockResolvedValueOnce({ ok: true, info: browserInfo({ via: null, proxy: tunnel.proxy, tabs }) })
    callbacks.onPanel('browser')
    callbacks.onToggle('socks5', true)
    await flush()
    expect(bridge.setBrowserTunnel, 'nothing is chosen before there is an address').not.toHaveBeenCalled()
    callbacks.onAddressInput('127.0.0.1:9050')
    callbacks.onSaveAddress('127.0.0.1:9050')
    await flush()
    expect(bridge.setProxyAddress).toHaveBeenCalledWith('127.0.0.1:9050')
    expect(shown.prompt, 'a tab keeps its own tunnel, so the person is asked').not.toBeNull()
    callbacks.onConfirm()
    await flush()
    expect(bridge.setBrowserTunnel).toHaveBeenCalledWith('socks5')
  })

  it('say the change did not take when main refused it', async () => {
    const { bridge, flush } = setup(browserInfo({ via: null }))
    bridge.setBrowserTunnel.mockResolvedValueOnce({ ok: false, info: browserInfo({ via: null }) })
    callbacks.onPanel('browser')
    callbacks.onToggle('nym', true)
    await flush()
    expect(shownView.failed).toBe(true)
    expect(rows.find((row) => row.kind.id === 'nym')?.on).toBe(false)
  })
})

describe('the nodes switch', () => {
  it('sets whether the IPFS and Swarm nodes follow the tunnel, and draws what main says', async () => {
    const { bridge, flush } = setup(browserInfo({ via: 'nym' }))
    expect(shown.nodes).toMatchObject({ on: false, disabled: false })
    callbacks.onNodes(true)
    await flush()
    expect(bridge.setNodesTunnel).toHaveBeenCalledWith(true)
    expect(shown.nodes?.on).toBe(true)
    callbacks.onNodes(false)
    await flush()
    expect(bridge.setNodesTunnel).toHaveBeenLastCalledWith(false)
  })

  it('says the change did not take when main refused it', async () => {
    const { bridge, flush } = setup(browserInfo({ via: 'nym' }))
    bridge.setNodesTunnel.mockResolvedValueOnce({ ok: false, info: browserInfo({ via: 'nym' }) })
    callbacks.onNodes(true)
    await flush()
    expect(shownView.failed).toBe(true)
  })
})
