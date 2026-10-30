import { describe, expect, it } from 'vitest'
import type { BrowserTunnel, SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { BROWSER_FAILED, BROWSER_LABEL, BROWSER_PROMPT, NODES_LABEL, NODES_LINE, browserListModel, firstPanelLabel, initialPanel, keptWords } from '../site-info/browser-wide-model.js'
import { HELD_LINE, NYM_OFF_LINE, PROXY_UNSET_LINE } from '../site-info/tunnels-model.js'

// The Browser-wide panel of the tunnels popup as data: which panel opens, what the two tabs are called, the rows of the whole
// browser's tunnel, the switch for the nodes and what the prompt lists.

const PROXY = { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, everything: false } }
const tunnel: SiteTunnel = { via: null, following: true, subject: 'site', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym', proxy: PROXY }
const browser: BrowserTunnel = { via: null, defaultKind: 'nym', nodes: false, blocked: {}, proxy: PROXY, unreadable: false, tabs: [] }
const base: SiteInfo = {
  origin: 'https://example.com', displayOrigin: 'example.com', claimedName: undefined, homeDomain: undefined, update: undefined, asked: true,
  capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [], tunnel, tunnelKind: 'nym', everywhere: false, browserTunnel: browser
}
const info = (patch: Partial<SiteInfo> = {}): SiteInfo => ({ ...base, ...patch })
/** A page with no tunnel of its own: this computer. */
const noTunnel = (patch: Partial<SiteInfo> = {}): SiteInfo => {
  const { tunnel: _omitted, ...rest } = { ...base, ...patch }
  return rest
}
const withBrowser = (patch: Partial<BrowserTunnel>, rest: Partial<SiteInfo> = {}): SiteInfo => info({ browserTunnel: { ...browser, ...patch }, ...rest })
const noView = { pending: undefined }
const row = (model: ReturnType<typeof browserListModel>, id: 'nym' | 'socks5') => model.rows.find((one) => one.kind.id === id)

describe('which panel opens', () => {
  it('is the first panel while the whole browser is not on a tunnel', () => {
    expect(initialPanel(info())).toBe('first')
    expect(initialPanel(noTunnel())).toBe('first')
  })

  it('is Browser-wide while the whole browser is on a tunnel and the page has no choice of its own', () => {
    expect(initialPanel(info({ everywhere: true }))).toBe('browser')
    expect(initialPanel(info({ everywhere: true, tunnel: { ...tunnel, following: true, via: 'nym' } }))).toBe('browser')
    expect(initialPanel(noTunnel({ everywhere: true }))).toBe('browser')
  })

  it('is the first panel for a page with a choice of its own, a tunnel or none, even with the whole browser on a tunnel', () => {
    expect(initialPanel(info({ everywhere: true, tunnel: { ...tunnel, following: false, via: 'socks5' } }))).toBe('first')
    expect(initialPanel(info({ everywhere: true, tunnel: { ...tunnel, subject: 'tab', following: false, via: null, tabChoice: 'direct' } }))).toBe('first')
  })

  it('is the first panel in a window held to a tunnel, whose rows are fixed there', () => {
    expect(initialPanel(info({ everywhere: true, tunnelHeld: 'nym' }))).toBe('first')
  })

  it('is the first panel when routes are not running, so there is no Browser-wide panel to open', () => {
    const { browserTunnel: _omitted, ...bare } = info({ everywhere: true })
    expect(initialPanel(bare)).toBe('first')
  })
})

describe('what the first tab is called', () => {
  it('says what its switches act on: a tab, a website, an installed app', () => {
    expect(firstPanelLabel(info({ tunnel: { ...tunnel, subject: 'tab' } }))).toBe('This tab')
    expect(firstPanelLabel(info())).toBe('This site')
    expect(firstPanelLabel(info({ tunnel: { ...tunnel, subject: 'app' } }))).toBe('This app')
  })

  it('says this tab where the page has no tunnel at all, as this computer has none', () => {
    expect(firstPanelLabel(noTunnel())).toBe('This tab')
  })

  it('names the second tab Browser-wide', () => {
    expect(BROWSER_LABEL).toBe('Browser-wide')
  })
})

describe('the rows of the whole browser\'s tunnel', () => {
  it('are Nym and the proxy, both off while the browser is on no tunnel, with no line and no note', () => {
    const model = browserListModel(info(), noView)
    expect(model.rows.map((one) => [one.kind.id, one.on, one.disabled])).toEqual([['nym', false, false], ['socks5', false, false]])
    expect(model.rows.map((one) => one.state.text)).toEqual(['', ''])
    expect(model.notes).toEqual([])
    expect(model.empty).toBeNull()
  })

  it('light the tunnel the browser is on and say what it does for the browser, in the words of a browser', () => {
    const model = browserListModel(withBrowser({ via: 'socks5', route: 'ok' }), noView)
    expect(row(model, 'socks5')).toMatchObject({ on: true, state: { text: 'This browser\'s traffic goes through your tunnel.', down: false } })
    expect(row(model, 'nym')).toMatchObject({ on: false, state: { text: '' } })
    const down = browserListModel(withBrowser({ via: 'socks5', route: 'down' }), noView)
    expect(row(down, 'socks5')?.state).toEqual({ text: 'Your tunnel is not answering, so this browser\'s traffic is stopped.', down: true })
    const nym = browserListModel(withBrowser({ via: 'nym', route: 'ok', nym: { state: 'ready' } }), noView)
    expect(row(nym, 'nym')?.state.text).toContain('This browser\'s traffic goes through Nym.')
  })

  it('show the switch moved while the prompt is open, as the storage notice does for a site', () => {
    const model = browserListModel(withBrowser({ via: null, tabs: [{ title: 'A', choice: 'nym' }] }), { pending: 'socks5' })
    expect(row(model, 'socks5')?.on).toBe(true)
    expect(row(model, 'nym')?.on).toBe(false)
  })

  it('cannot take a tunnel that cannot be used, and say why, as the first panel does', () => {
    const noProxy = browserListModel(withBrowser({ blocked: { socks5: 'no-proxy' }, proxy: { ...PROXY, address: '' } }), noView)
    expect(row(noProxy, 'socks5')).toMatchObject({ disabled: false, pressOpensEditor: true })
    expect(row(noProxy, 'socks5')?.address).toMatchObject({ saved: '', editing: true })
    const nymOff = browserListModel(withBrowser({ blocked: { nym: 'nym-off' } }), noView)
    expect(row(nymOff, 'nym')).toMatchObject({ disabled: true, state: { text: NYM_OFF_LINE, down: true } })
    expect(PROXY_UNSET_LINE).toBe('No proxy address is set.')
  })

  it('keep the lit tunnel switchable off even when it can no longer be used', () => {
    const model = browserListModel(withBrowser({ via: 'nym', blocked: { nym: 'nym-off' } }), noView)
    expect(row(model, 'nym')).toMatchObject({ on: true, disabled: false })
  })

  it('show Nym on and both rows fixed in a window held to Nym, with the line that says why', () => {
    const model = browserListModel(withBrowser({ via: 'nym' }, { tunnelHeld: 'nym', everywhere: true }), noView)
    expect(row(model, 'nym')).toMatchObject({ on: true, disabled: true })
    expect(row(model, 'socks5')).toMatchObject({ on: false, disabled: true })
    expect(model.notes.map((note) => note.text)).toContain(HELD_LINE)
  })

  it('are fixed, with the reason, while the tunnel settings cannot be read', () => {
    const model = browserListModel(withBrowser({ via: 'nym', unreadable: true }, { everywhere: true }), noView)
    expect(model.rows.every((one) => one.disabled)).toBe(true)
    expect(model.notes[0]).toMatchObject({ down: true })
    expect(model.notes[0]?.text).toContain('could not read your tunnel settings')
  })

  it('say nothing of a site, a tab or an app: no extensions, no storage, no updates, no tab note', () => {
    const model = browserListModel(withBrowser({ via: 'nym' }, { tunnel: { ...tunnel, subject: 'tab', following: false, via: 'socks5', tabChoice: 'socks5' }, extensionsOnSite: ['uBlock Origin'] }), noView)
    expect(model.notes).toEqual([])
  })

  it('open the proxy\'s address and ask before a change that sites and apps feel, from the browser\'s facts', () => {
    const users = { sites: 2, apps: 1, everything: false }
    const model = browserListModel(withBrowser({ proxy: { address: '127.0.0.1:9050', users } }), { pending: undefined, editor: { text: '127.0.0.1:9150', error: null, confirm: true } })
    expect(row(model, 'socks5')?.address?.confirm).toContain('2 sites and 1 app')
  })

  it('end in the one link to Tunnels settings, with no hint of its own', () => {
    expect(browserListModel(info(), noView).hint).toEqual({ text: '' })
  })
})

describe('the switch for the nodes', () => {
  it('is on the Browser-wide panel only, worded as the owner asked', () => {
    expect(NODES_LABEL).toBe('Also use for IPFS and Swarm nodes')
    expect(NODES_LINE).toBe('More private, but pages from these networks load more slowly.')
    expect(browserListModel(info(), noView).nodes).toMatchObject({ label: NODES_LABEL, line: NODES_LINE })
  })

  it('cannot be turned on while no tunnel is on browser-wide, and can still be turned off when it is saved on, because the nodes keep their rule about tunnelled sites then', () => {
    expect(browserListModel(withBrowser({ via: null, nodes: false }), noView).nodes).toMatchObject({ on: false, disabled: true })
    expect(browserListModel(withBrowser({ via: null, nodes: true }), noView).nodes).toMatchObject({ on: true, disabled: false })
  })

  it('moves while a tunnel is on browser-wide, and shows what is saved', () => {
    expect(browserListModel(withBrowser({ via: 'nym', nodes: false }), noView).nodes).toMatchObject({ on: false, disabled: false })
    expect(browserListModel(withBrowser({ via: 'socks5', nodes: true }), noView).nodes).toMatchObject({ on: true, disabled: false })
  })

  it('cannot be moved in a held window, or while the settings cannot be read', () => {
    expect(browserListModel(withBrowser({ via: 'nym' }, { tunnelHeld: 'nym' }), noView).nodes?.disabled).toBe(true)
    expect(browserListModel(withBrowser({ via: 'nym', unreadable: true }), noView).nodes?.disabled).toBe(true)
  })

  it('is not part of the first panel', async () => {
    const { tunnelListModel } = await import('../site-info/tunnels-model.js')
    expect(tunnelListModel(info(), noView).nodes).toBeNull()
  })
})

describe('the prompt before a tunnel is set browser-wide', () => {
  const tabs: BrowserTunnel['tabs'] = [{ title: 'News', choice: 'nym' }, { title: 'Bank', choice: 'direct' }, { title: '', choice: 'socks5' }]

  it('is not open until a switch asked for it', () => {
    expect(browserListModel(withBrowser({ tabs }), noView).prompt).toBeNull()
  })

  it('says some tabs keep their own tunnel and lists each, with the tunnel it keeps, direct ones included', () => {
    expect(BROWSER_PROMPT).toBe('You are setting this tunnel browser-wide, but some tabs will keep using their tab-specific tunnel.')
    const prompt = browserListModel(withBrowser({ tabs }), { pending: 'nym' }).prompt
    expect(prompt?.text).toBe(BROWSER_PROMPT)
    expect(prompt?.tabs).toEqual([{ title: 'News', kept: 'Nym' }, { title: 'Bank', kept: 'Direct' }, { title: 'New tab', kept: 'Your proxy' }])
  })

  it('names what a tab keeps in the words of the rows', () => {
    expect([keptWords('nym'), keptWords('socks5'), keptWords('direct')]).toEqual(['Nym', 'Your proxy', 'Direct'])
  })

  it('is not open for the lit tunnel turned off, which asks nothing', () => {
    expect(browserListModel(withBrowser({ via: 'nym', tabs }), { pending: null }).prompt).toBeNull()
  })

  it('is not open when no tab keeps a choice of its own', () => {
    expect(browserListModel(withBrowser({ tabs: [] }), { pending: 'socks5' }).prompt).toBeNull()
  })

  it('has a sentence for a change that could not be made', () => {
    expect(BROWSER_FAILED).toBe('The tunnel could not be changed for the browser.')
  })
})
