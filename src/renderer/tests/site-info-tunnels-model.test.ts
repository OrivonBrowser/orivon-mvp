import { describe, expect, it } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { APP_UPDATES_NOTE, ENFORCE_LINK, HELD_LINE, NO_SWITCH_NOTE, NYM_OFF_LINE, NYM_OFF_LINK, PROXY_UNSET_LINE, PROXY_UNSET_LINK, TUNNEL_KINDS, everywhereHint, openedLine, tunnelListModel } from '../site-info/tunnels-model.js'

const tunnel: SiteTunnel = { via: null, following: true, subject: 'site', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym' }
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
    expect(model.hint).toEqual({ text: '', link: 'Open Tunnels settings', everywhere: false })
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

  it('says the proxy has no address, and links to Settings, without holding Nym up', () => {
    const model = tunnelListModel(withTunnel({ blocked: { socks5: 'no-proxy' } }), noView)
    expect(row(model, 'socks5')).toMatchObject({ disabled: true, settingsLink: PROXY_UNSET_LINK, state: { text: PROXY_UNSET_LINE, down: true } })
    expect(row(model, 'nym')?.disabled).toBe(false)
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
    const model = tunnelListModel(withTunnel({ via: 'nym', profile: 'tunnel' }, { extensionsOnSite: ['uBlock Origin'], route: 'ok', nym: { state: 'ready' } }), noView)
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
    expect(tunnelListModel(app({ via: 'nym', profile: 'tunnel' }, { extensionsOnSite: ['uBlock Origin'], route: 'ok' }), noView).notes.map((note) => note.text).join(' ')).not.toContain('extensions run')
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

describe('the hint under the list', () => {
  it('leads to the browser-wide switch while it is off', () => {
    expect(tunnelListModel(info(), noView).hint).toEqual({ text: '', link: ENFORCE_LINK, everywhere: true })
    expect(ENFORCE_LINK).toBe('Enforce a tunnel browser-wide')
  })

  it('names the tunnel everything without a choice follows while the browser-wide switch is on, and links to Tunnels settings', () => {
    expect(tunnelListModel(info({ everywhere: true }), noView).hint).toEqual({ text: everywhereHint('nym'), link: 'Open Tunnels settings', everywhere: false })
    expect(everywhereHint('socks5')).toBe('Every site and app that has no choice here goes through your proxy. Change this in Tunnels settings.')
    expect(tunnelListModel(withTunnel({ defaultKind: 'socks5' }, { everywhere: true }), noView).hint.text).toBe(everywhereHint('socks5'))
  })

  it('says it also on a page with no choice of its own', () => {
    expect(tunnelListModel(noSwitch({ everywhere: true }), noView).hint.link).toBe('Open Tunnels settings')
  })
})
