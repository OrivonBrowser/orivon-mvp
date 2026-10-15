import { describe, expect, it } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { ENFORCE_LINK, EVERYWHERE_HINT, NO_SWITCH_NOTE, NYM_OFF_LINE, TUNNEL_KINDS, anyTunnelOn, tunnelListModel } from '../site-info/tunnels-model.js'

const tunnel: SiteTunnel = { on: false, swarm: false, unreadable: false, kind: 'nym', nymOff: false, everywhere: false }
const base: SiteInfo = {
  origin: 'https://example.com', displayOrigin: 'example.com', claimedName: undefined, homeDomain: undefined, update: undefined, asked: true,
  capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [], tunnel
}
const info = (patch: Partial<SiteInfo> = {}): SiteInfo => ({ ...base, ...patch })
/** A page with no tunnel switch: an installed app, a local file or this computer. */
const noSwitch = (patch: Partial<SiteInfo> = {}): SiteInfo => {
  const { tunnel: _omitted, ...rest } = { ...base, ...patch }
  return rest
}
const noView = { next: null }

describe('the tunnel kinds Orivon offers', () => {
  it('lists Nym with its logo, and the person\'s own SOCKS5 address with the generic icon', () => {
    expect(TUNNEL_KINDS.map((kind) => kind.id)).toEqual(['nym', 'socks5'])
    expect(TUNNEL_KINDS[0]?.name).toBe('Nym')
    expect(TUNNEL_KINDS[0]?.logo).toMatch(/nym.*\.png$/)
    expect(TUNNEL_KINDS[1]).toMatchObject({ name: 'Your SOCKS5 tunnel', logo: null })
  })
})

describe('the rows of a website', () => {
  it('is one row, Nym, with its switch off and a plain line, while the site goes direct', () => {
    const model = tunnelListModel(info(), noView)
    expect(model.rows).toHaveLength(1)
    expect(model.rows[0]).toMatchObject({ kind: { id: 'nym' }, on: false, disabled: false, state: { text: 'This site is not sent through the tunnel.', down: false }, settingsLink: false })
    expect(anyTunnelOn(model)).toBe(false)
  })

  it('names the person\'s own tunnel when that is the choice', () => {
    expect(tunnelListModel(info({ tunnel: { ...tunnel, kind: 'socks5' } }), noView).rows[0]?.kind.name).toBe('Your SOCKS5 tunnel')
  })

  it('is on, with what Nym is doing, once the site goes through it', () => {
    const model = tunnelListModel(info({ tunnel: { ...tunnel, on: true }, route: 'ok', nym: { state: 'ready' } }), noView)
    expect(model.rows[0]).toMatchObject({ on: true, state: { text: 'This site\'s traffic goes through Nym. Nym tunnel ready', down: false } })
    expect(anyTunnelOn(model)).toBe(true)
  })

  it('shows the switch where the person moved it while the storage notice is open', () => {
    expect(tunnelListModel(info(), { next: true }).rows[0]?.on).toBe(true)
  })

  it('says the tunnel is not answering in the warning colour', () => {
    const row = tunnelListModel(info({ tunnel: { ...tunnel, on: true }, route: 'down', nym: { state: 'failed', reason: 'no gateway' } }), noView).rows[0]
    expect(row?.state.down).toBe(true)
  })

  it('fixes the switch off, says why and links to Settings when Nym is switched off there', () => {
    const row = tunnelListModel(info({ tunnel: { ...tunnel, nymOff: true } }), noView).rows[0]
    expect(row).toMatchObject({ disabled: true, settingsLink: true, state: { text: NYM_OFF_LINE, down: true } })
  })

  it('still lets a site that is on be switched off while Nym is switched off', () => {
    expect(tunnelListModel(info({ tunnel: { ...tunnel, on: true, nymOff: true } }), noView).rows[0]?.disabled).toBe(false)
  })

  it('keeps the switch\'s hints: no tunnel set, Swarm, unreadable settings', () => {
    const noProxy = tunnelListModel(info({ tunnel: { ...tunnel, kind: 'socks5', blocked: 'no-proxy' } }), noView).rows[0]
    expect(noProxy).toMatchObject({ disabled: true })
    expect(noProxy?.notes[0]).toEqual({ text: 'Set a tunnel under Tunnels first.', down: true })
    expect(tunnelListModel(info({ tunnel: { ...tunnel, swarm: true } }), noView).rows[0]?.notes[0]?.text).toContain('Swarm')
    expect(tunnelListModel(info({ tunnel: { ...tunnel, unreadable: true, on: true } }), noView).rows[0]).toMatchObject({ disabled: true })
  })

  it('says what the profile gives the extensions', () => {
    const row = tunnelListModel(info({ tunnel: { ...tunnel, on: true, profile: 'tunnel' }, extensionsOnSite: ['uBlock Origin'], route: 'ok', nym: { state: 'ready' } }), noView).rows[0]
    expect(row?.notes.at(-1)?.text).toContain('Your extensions run in the tunnel profile too: uBlock Origin')
  })
})

describe('an installed app and a page opened from one', () => {
  it('shows the app\'s route with a fixed switch, because its switch is on its card in Settings', () => {
    const model = tunnelListModel(noSwitch({ route: 'ok', nym: { state: 'ready' } }), noView)
    expect(model.rows[0]).toMatchObject({ kind: { id: 'nym' }, on: true, disabled: true })
    expect(model.rows[0]?.state.text).toContain('This app\'s traffic goes through Nym')
  })

  it('does the same for a temporary page, in words about the page', () => {
    const model = tunnelListModel(info({ route: 'temporary' }), noView)
    expect(model.rows[0]).toMatchObject({ on: true, disabled: true })
    expect(model.rows[0]?.state.text).toContain('nothing it stores is kept')
  })

  it('has no row for a page with no tunnel switch, and says so', () => {
    expect(tunnelListModel(noSwitch(), noView)).toMatchObject({ rows: [], empty: NO_SWITCH_NOTE })
  })
})

describe('the hint under the list', () => {
  it('leads to the browser-wide switch while it is off', () => {
    expect(tunnelListModel(info(), noView).hint).toEqual({ text: '', link: ENFORCE_LINK, everywhere: true })
    expect(ENFORCE_LINK).toBe('Enforce a tunnel browser-wide')
  })

  it('says every site goes through the tunnel while it is on, and links to Tunnels settings', () => {
    expect(tunnelListModel(info({ tunnel: { ...tunnel, everywhere: true } }), noView).hint).toEqual({ text: EVERYWHERE_HINT, link: 'Open Tunnels settings', everywhere: false })
  })
})
