import { describe, expect, it } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { ADDRESS_PROBLEM, APP_UPDATES_NOTE, HELD_LINE, NO_SWITCH_NOTE, NYM_OFF_LINE, NYM_OFF_LINK, PROXY_UNSET_LINE, SETTINGS_LINK, TUNNEL_KINDS, addressChangeWords, openedLine, tunnelListModel } from '../site-info/tunnels-model.js'

const tunnel: SiteTunnel = { via: null, following: true, subject: 'site', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym', proxy: { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, tabs: 0, everything: false } } }
const base: SiteInfo = {
  origin: 'https://example.com', displayOrigin: 'example.com', claimedName: undefined, homeDomain: undefined, update: undefined, asked: true,
  capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [], tunnel, tunnelKind: 'nym', everywhere: false
}
const info = (patch: Partial<SiteInfo> = {}): SiteInfo => ({ ...base, ...patch })
const withTunnel = (patch: Partial<SiteTunnel>, rest: Partial<SiteInfo> = {}): SiteInfo => info({ tunnel: { ...tunnel, ...patch }, ...rest })
/** A page with no tunnel choice: a local file or this computer. */
const noSwitch = (patch: Partial<SiteInfo> = {}): SiteInfo => {
  const { tunnel: _omitted, ...rest } = { ...base, ...patch }
  return rest
}
const noView = { pending: undefined }
const USERS = { sites: 2, apps: 1, tabs: 0, everything: false }
const row = (model: ReturnType<typeof tunnelListModel>, id: 'nym' | 'socks5') => model.rows.find((one) => one.kind.id === id)

describe('the tunnels Orivon offers', () => {
  it('lists Nym with its logo, and the person\'s own proxy with the generic icon', () => {
    expect(TUNNEL_KINDS.map((kind) => kind.id)).toEqual(['nym', 'socks5'])
    expect(TUNNEL_KINDS[0]?.name).toBe('Nym')
    expect(TUNNEL_KINDS[0]?.logo).toMatch(/nym.*\.png$/)
    expect(TUNNEL_KINDS[1]).toMatchObject({ name: 'Your proxy', who: 'your proxy', logo: null })
  })
})

describe('a private window held to Nym', () => {
  const held = (patch: Partial<SiteInfo> = {}): SiteInfo => withTunnel({ via: 'nym', following: false }, { tunnelHeld: 'nym', everywhere: true, route: 'ok', nym: { state: 'ready' }, ...patch })

  it('shows Nym on and both switches fixed, with the line that says why', () => {
    const model = tunnelListModel(held(), noView)
    expect(row(model, 'nym')).toMatchObject({ on: true, disabled: true })
    expect(row(model, 'socks5')).toMatchObject({ on: false, disabled: true })
    expect(model.notes.map((note) => note.text)).toContain(HELD_LINE)
  })

  it('cannot be shown off or on the proxy, even for a site the model was told was not routed or while a notice asks to move it', () => {
    const model = tunnelListModel(withTunnel({ via: null }, { tunnelHeld: 'nym', everywhere: true }), { pending: 'socks5' })
    expect(row(model, 'nym')).toMatchObject({ on: true, disabled: true })
    expect(row(model, 'socks5')).toMatchObject({ on: false })
  })

  it('says the same for an installed app, and offers no browser-wide switch to turn on', () => {
    const model = tunnelListModel(held({ tunnel: { ...tunnel, subject: 'app', via: 'nym' } }), noView)
    expect(model.notes.map((note) => note.text)).toContain(HELD_LINE)
    expect(model.notes.map((note) => note.text), 'a held window gives up nothing for an app').not.toContain(APP_UPDATES_NOTE)
  })

  it('leaves an ordinary window\'s rows as they were', () => {
    expect(tunnelListModel(info(), noView).notes.map((note) => note.text)).not.toContain(HELD_LINE)
  })
})

describe('the rows of a website', () => {
  it('is a row for Nym and one for the proxy, both off with no line, while the site goes direct', () => {
    const model = tunnelListModel(info(), noView)
    expect(model.rows.map((one) => one.kind.id)).toEqual(['nym', 'socks5'])
    for (const one of model.rows) expect(one).toMatchObject({ on: false, disabled: false, state: { text: '', down: false }, settingsLink: null })
  })

  it('lights only the tunnel the site goes through, with what it is doing', () => {
    const model = tunnelListModel(withTunnel({ via: 'nym', following: false }, { route: 'ok', nym: { state: 'ready' } }), noView)
    expect(row(model, 'nym')).toMatchObject({ on: true, state: { text: 'This site\'s traffic goes through Nym. Nym tunnel ready', down: false } })
    expect(row(model, 'socks5')).toMatchObject({ on: false, state: { text: '' } })
  })

  it('lights the proxy when that is the site\'s tunnel, in words about the proxy', () => {
    const model = tunnelListModel(withTunnel({ via: 'socks5', following: false }, { route: 'ok', tunnelKind: 'socks5' }), noView)
    expect(row(model, 'socks5')).toMatchObject({ on: true, state: { text: 'This site\'s traffic goes through your tunnel.' } })
    expect(row(model, 'nym')?.on).toBe(false)
  })

  it('shows the switches where the person moved them while the storage notice is open, and shows the pending choice as not yet in use', () => {
    const model = tunnelListModel(info(), { pending: 'socks5' })
    expect(row(model, 'socks5')).toMatchObject({ on: true, state: { text: '' } })
    expect(row(model, 'nym')?.on).toBe(false)
    expect(row(tunnelListModel(withTunnel({ via: 'nym' }, { route: 'ok' }), { pending: null }), 'nym')?.on, 'a pending choice of none puts every switch off').toBe(false)
  })

  it('says the tunnel is not answering in the warning colour', () => {
    const model = tunnelListModel(withTunnel({ via: 'nym' }, { route: 'down', nym: { state: 'failed', reason: 'no gateway' } }), noView)
    expect(row(model, 'nym')?.state.down).toBe(true)
  })

  it('fixes the Nym switch off, says why and links to Settings when Nym is switched off there, and leaves the proxy to choose', () => {
    const model = tunnelListModel(withTunnel({ blocked: { nym: 'nym-off' } }), noView)
    expect(row(model, 'nym')).toMatchObject({ disabled: true, settingsLink: NYM_OFF_LINK, state: { text: NYM_OFF_LINE, down: true } })
    expect(row(model, 'socks5')).toMatchObject({ disabled: false, settingsLink: null })
  })

  it('lets the proxy\'s switch ask for an address when none is saved, without holding Nym up', () => {
    const model = tunnelListModel(withTunnel({ blocked: { socks5: 'no-proxy' }, proxy: { ...tunnel.proxy, address: '' } }), noView)
    expect(row(model, 'socks5')).toMatchObject({ disabled: false, pressOpensEditor: true, settingsLink: null, address: { saved: '', editing: true, text: '', error: null, confirm: null } })
    expect(row(model, 'nym')).toMatchObject({ disabled: false, pressOpensEditor: false })
    expect(PROXY_UNSET_LINE).toBe('No proxy address is set.')
  })

  it('still lets a site that is on a tunnel that cannot take a site now be switched off', () => {
    expect(row(tunnelListModel(withTunnel({ via: 'nym', blocked: { nym: 'nym-off' } }), noView), 'nym')?.disabled).toBe(false)
  })

  it('keeps the hints: Swarm, and unreadable settings fix every switch', () => {
    expect(tunnelListModel(withTunnel({ swarm: true }), noView).notes[0]?.text).toContain('Swarm')
    const unreadable = tunnelListModel(withTunnel({ unreadable: true, via: 'nym' }), noView)
    for (const one of unreadable.rows) expect(one.disabled).toBe(true)
    expect(unreadable.notes[0]).toMatchObject({ down: true })
  })

  it('says what the profile gives the extensions', () => {
    const model = tunnelListModel(withTunnel({ via: 'nym', profile: 'nym' }, { extensionsOnSite: ['uBlock Origin'], route: 'ok', nym: { state: 'ready' } }), noView)
    expect(model.notes.at(-1)?.text).toContain('Your extensions run in the tunnel profile too: uBlock Origin')
  })
})

describe('an installed app', () => {
  const app = (patch: Partial<SiteTunnel> = {}, rest: Partial<SiteInfo> = {}): SiteInfo => withTunnel({ subject: 'app', ...patch }, rest)

  it('has the same rows as a website, with words about the app', () => {
    const model = tunnelListModel(app({ via: 'nym', following: false }, { route: 'ok', nym: { state: 'ready' } }), noView)
    expect(model.rows.map((one) => one.kind.id)).toEqual(['nym', 'socks5'])
    expect(row(model, 'nym')).toMatchObject({ on: true, disabled: false })
    expect(row(model, 'nym')?.state.text).toContain('This app\'s traffic goes through Nym')
  })

  it('says its updates are not checked while it goes through a tunnel, and nothing while it goes through none', () => {
    expect(tunnelListModel(app({ via: 'nym' }, { route: 'ok' }), noView).notes.map((note) => note.text)).toContain(APP_UPDATES_NOTE)
    expect(tunnelListModel(app(), noView).notes.map((note) => note.text)).not.toContain(APP_UPDATES_NOTE)
  })

  it('has no word about a profile or the extensions in one', () => {
    expect(tunnelListModel(app({ via: 'nym', profile: 'nym' }, { extensionsOnSite: ['uBlock Origin'], route: 'ok' }), noView).notes.map((note) => note.text).join(' ')).not.toContain('extensions run')
  })
})

describe('a page that does not choose its tunnel here', () => {
  it('shows the tunnel of a temporary page on and both switches fixed, in words about the page', () => {
    const model = tunnelListModel(withTunnel({ via: 'socks5', following: false, fixed: 'temporary' }, { route: 'temporary', tunnelKind: 'socks5' }), noView)
    expect(row(model, 'socks5')).toMatchObject({ on: true, disabled: true })
    expect(row(model, 'nym')).toMatchObject({ on: false, disabled: true })
    expect(row(model, 'socks5')?.state.text).toContain('nothing it stores is kept')
  })

  it('says a page an app opened goes through the app\'s tunnel, and fixes the switches', () => {
    const model = tunnelListModel(withTunnel({ via: 'nym', following: false, fixed: 'opened' }, { route: 'idle', nym: { state: 'ready' } }), noView)
    expect(row(model, 'nym')).toMatchObject({ on: true, disabled: true })
    expect(model.notes.map((note) => note.text)).toContain(openedLine('nym'))
    expect(openedLine('nym')).toBe('This page goes through Nym because the app that opened it does.')
  })

  it('has no row for a page from this computer, and says so in one sentence', () => {
    expect(tunnelListModel(noSwitch(), noView)).toMatchObject({ rows: [], empty: NO_SWITCH_NOTE })
    expect(NO_SWITCH_NOTE).toBe('A page from this computer is never sent through a tunnel.')
  })
})

describe('under the list', () => {
  it('is the link to Tunnels settings and nothing else, however the browser is set: the Browser-wide panel says what it does itself', () => {
    expect(SETTINGS_LINK).toBe('Open Tunnels settings')
    for (const model of [
      tunnelListModel(info(), noView),
      tunnelListModel(info({ everywhere: true }), noView),
      tunnelListModel(withTunnel({ defaultKind: 'socks5' }, { everywhere: true }), noView),
      tunnelListModel(info({ everywhere: true, tunnelHeld: 'nym' }), noView),
      tunnelListModel(noSwitch({ everywhere: true }), noView)
    ]) expect(model).not.toHaveProperty('hint')
  })
})

describe('the address of the proxy', () => {
  const saved = { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, tabs: 0, everything: false } }

  it('is shown with a Change link, and no field, while one is saved', () => {
    expect(row(tunnelListModel(info(), noView), 'socks5')?.address).toEqual({ saved: '127.0.0.1:9050', editing: false, text: '127.0.0.1:9050', error: null, confirm: null })
  })

  it('opens the field with what the person typed, and the reason a Save did not take', () => {
    const model = tunnelListModel(info(), { pending: undefined, editor: { text: 'nonsense', error: ADDRESS_PROBLEM, confirm: false } })
    expect(row(model, 'socks5')?.address).toEqual({ saved: '127.0.0.1:9050', editing: true, text: 'nonsense', error: 'Enter an address as host:port, like 127.0.0.1:9050', confirm: null })
    expect(row(model, 'nym')?.address, 'only the proxy has an address').toBeNull()
  })

  it('asks before an address that sites and apps use is changed, naming how many', () => {
    const model = tunnelListModel(withTunnel({ proxy: { ...saved, users: USERS } }), { pending: undefined, editor: { text: '127.0.0.1:9150', error: null, confirm: true } })
    expect(row(model, 'socks5')?.address?.confirm).toBe('2 sites and 1 app go through your proxy now. They will use the new address, and what they have open is closed.')
  })

  it('words the question for one, for apps only, and for the whole browser', () => {
    expect(addressChangeWords({ sites: 1, apps: 0, tabs: 0, everything: false })).toBe('1 site goes through your proxy now. It will use the new address, and what it has open is closed.')
    expect(addressChangeWords({ sites: 0, apps: 3, tabs: 0, everything: false })).toBe('3 apps go through your proxy now. They will use the new address, and what they have open is closed.')
    expect(addressChangeWords({ sites: 1, apps: 0, tabs: 0, everything: true })).toBe('Everything you browse and 1 site go through your proxy now. They will use the new address, and what they have open is closed.')
    expect(addressChangeWords({ sites: 0, apps: 0, tabs: 0, everything: false })).toBe('')
  })

  it('names the tabs that chose the proxy, one or more, alone or with the rest', () => {
    const words = (users: Partial<SiteTunnel['proxy']['users']>): string => addressChangeWords({ sites: 0, apps: 0, tabs: 0, everything: false, ...users })
    expect(words({ tabs: 1 })).toBe('1 tab goes through your proxy now. It will use the new address, and what it has open is closed.')
    expect(words({ tabs: 2 })).toBe('2 tabs go through your proxy now. They will use the new address, and what they have open is closed.')
    expect(words({ tabs: 1, sites: 1 })).toBe('1 tab and 1 site go through your proxy now. They will use the new address, and what they have open is closed.')
    expect(words({ tabs: 3, sites: 2, apps: 1 })).toBe('3 tabs, 2 sites and 1 app go through your proxy now. They will use the new address, and what they have open is closed.')
    expect(words({ everything: true, tabs: 1 })).toBe('Everything you browse and 1 tab go through your proxy now. They will use the new address, and what they have open is closed.')
  })

  it('asks before an address is changed when only tabs go through the proxy', () => {
    const model = tunnelListModel(withTunnel({ proxy: { ...saved, users: { sites: 0, apps: 0, tabs: 2, everything: false } } }), { pending: undefined, editor: { text: '127.0.0.1:9150', error: null, confirm: true } })
    expect(row(model, 'socks5')?.address?.confirm).toBe('2 tabs go through your proxy now. They will use the new address, and what they have open is closed.')
  })

  it('has no address and no Test where the choice is fixed', () => {
    const model = tunnelListModel(withTunnel({ fixed: 'opened', via: 'nym' }), noView)
    for (const one of model.rows) expect(one).toMatchObject({ address: null, canTest: false, pressOpensEditor: false })
    expect(tunnelListModel(info({ tunnelHeld: 'nym' }), noView).rows.every((one) => one.address === null && !one.canTest)).toBe(true)
  })
})

describe('the Test of a tunnel', () => {
  it('is offered for Nym unless it is switched off, and for the proxy once an address is saved', () => {
    const model = tunnelListModel(info(), noView)
    expect(model.rows.map((one) => one.canTest)).toEqual([true, true])
    expect(row(tunnelListModel(withTunnel({ blocked: { nym: 'nym-off' } }), noView), 'nym')?.canTest).toBe(false)
    expect(row(tunnelListModel(withTunnel({ proxy: { ...tunnel.proxy, address: '' } }), noView), 'socks5')?.canTest).toBe(false)
  })

  it('says it is under way, and then what it found, on the row it was pressed on only', () => {
    const busy = tunnelListModel(info(), { pending: undefined, test: { kind: 'socks5', busy: true, result: null } })
    expect(row(busy, 'socks5')?.testLine).toEqual({ text: 'Testing…', down: false, busy: true })
    expect(row(busy, 'nym')?.testLine).toBeNull()
    const answered = tunnelListModel(info(), { pending: undefined, test: { kind: 'socks5', busy: false, result: { ok: true, authentication: 'none' } } })
    expect(row(answered, 'socks5')?.testLine).toEqual({ text: 'The tunnel answered.', down: false, busy: false })
    const failed = tunnelListModel(info(), { pending: undefined, test: { kind: 'socks5', busy: false, result: { ok: false, reason: 'unreachable' } } })
    expect(row(failed, 'socks5')?.testLine).toEqual({ text: 'Nothing answered at that address.', down: true, busy: false })
  })

  it('says what Nym did in the words of Nym', () => {
    const answered = tunnelListModel(info(), { pending: undefined, test: { kind: 'nym', busy: false, result: { nym: true, ok: true, ms: 4250 } } })
    expect(row(answered, 'nym')?.testLine?.text).toContain('4.3 s')
  })
})
