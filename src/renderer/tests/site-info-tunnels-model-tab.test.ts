import { describe, expect, it } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { TAB_DIRECT_PROFILE_NOTE, TAB_FOLLOWING_NOTE, TAB_PICK_NOTE, TAB_TUNNEL_FAILED, TAB_TUNNEL_PROFILE_NOTE, directTabNote, tabNotes } from '../site-info/tab-words.js'
import { HELD_LINE, NYM_OFF_LINE, tunnelListModel } from '../site-info/tunnels-model.js'

// The tunnels page when it is about a tab (ADR-0101): the same rows, the words of a tab, and no storage notice.

const tunnel: SiteTunnel = { via: null, following: true, subject: 'tab', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym', proxy: { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, everything: false } } }
const base: SiteInfo = {
  origin: '', displayOrigin: 'This tab', claimedName: undefined, homeDomain: undefined, update: undefined, asked: false,
  capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [], tunnel, tunnelKind: 'nym', everywhere: false
}
const tab = (patch: Partial<SiteTunnel> = {}, rest: Partial<SiteInfo> = {}): SiteInfo => ({ ...base, tunnel: { ...tunnel, ...patch }, ...rest })
const noView = { pending: undefined }
const row = (model: ReturnType<typeof tunnelListModel>, id: 'nym' | 'socks5') => model.rows.find((one) => one.kind.id === id)
const notes = (info: SiteInfo): string[] => tunnelListModel(info, noView).notes.map((note) => note.text)

describe('the tunnels page of a tab', () => {
  it('lists Nym and the proxy, both off with no line, for a tab whose sites go direct', () => {
    const model = tunnelListModel(tab(), noView)
    expect(model.rows.map((one) => [one.kind.id, one.on, one.disabled])).toEqual([['nym', false, false], ['socks5', false, false]])
    expect(model.rows.map((one) => one.state.text)).toEqual(['', ''])
    expect(model.empty).toBeNull()
  })

  it('lights the tunnel the tab chose and says what it is doing for the tab, in the words of a tab', () => {
    const model = tunnelListModel(tab({ via: 'nym', following: false, tabChoice: 'nym' }, { route: 'ok', nym: { state: 'off' } }), noView)
    expect(row(model, 'nym')).toMatchObject({ on: true, state: { text: 'This tab\'s traffic goes through Nym.', down: false } })
    expect(row(model, 'socks5')).toMatchObject({ on: false })
  })

  it('says the tab\'s traffic is stopped when its tunnel does not answer', () => {
    const model = tunnelListModel(tab({ via: 'socks5', following: false, tabChoice: 'socks5' }, { route: 'down' }), noView)
    expect(row(model, 'socks5')?.state).toEqual({ text: 'Your tunnel is not answering, so this tab\'s traffic is stopped.', down: true })
  })

  it('lights the default tunnel for a tab that follows a browser on a tunnel, and nothing for a tab set to go direct under it', () => {
    const following = tunnelListModel(tab({ via: 'nym', following: true }, { everywhere: true, route: 'ok' }), noView)
    expect(row(following, 'nym')?.on).toBe(true)
    const direct = tunnelListModel(tab({ via: null, following: false, tabChoice: 'direct' }, { everywhere: true }), noView)
    expect(direct.rows.map((one) => one.on)).toEqual([false, false])
  })

  it('says direct for this tab under a browser on a tunnel, and names the direct profile its sites keep their sign-ins in', () => {
    const list = notes(tab({ via: null, following: false, tabChoice: 'direct' }, { everywhere: true }))
    expect(list).toContain(directTabNote(true))
    expect(list).toContain(TAB_DIRECT_PROFILE_NOTE)
    expect(directTabNote(true)).toBe('Direct for this tab: the sites you open here do not use a tunnel, while the rest of your browsing does.')
    expect(directTabNote(false)).toBe('Direct for this tab: the sites you open here do not use a tunnel.')
  })

  it('names the choice, so a tab opened on a website still says what is set for every site in it', () => {
    expect(notes(tab({ via: 'nym', following: false, tabChoice: 'nym' }))).toEqual(['Every site you open in this tab goes through Nym, until the tab is closed.', TAB_TUNNEL_PROFILE_NOTE])
    expect(notes(tab({ via: 'socks5', following: false, tabChoice: 'socks5' }))).toContain('Every site you open in this tab goes through your tunnel, until the tab is closed.')
  })

  it('asks the person to pick, or says the tab follows the browser', () => {
    expect(notes(tab())).toEqual([TAB_PICK_NOTE])
    expect(notes(tab({ via: 'nym' }, { everywhere: true }))).toEqual([TAB_FOLLOWING_NOTE])
  })

  it('asks for no notice before a first move into a profile, and offers no storage line of a website', () => {
    const model = tunnelListModel(tab({ via: 'nym', following: false, tabChoice: 'nym' }), { pending: undefined })
    expect(model.notes.map((note) => note.text).join(' ')).not.toContain('moves to your')
  })

  it('shows the tunnel that cannot be chosen, and fixes the switches in a private window held to Nym or when the settings cannot be read', () => {
    const off = tunnelListModel(tab({ blocked: { nym: 'nym-off' } }), noView)
    expect(row(off, 'nym')).toMatchObject({ disabled: true, state: { text: NYM_OFF_LINE, down: true } })
    const held = tunnelListModel(tab({ via: 'nym', following: true }, { tunnelHeld: 'nym', everywhere: true }), noView)
    expect(row(held, 'nym')).toMatchObject({ on: true, disabled: true })
    expect(held.notes.map((note) => note.text)).toEqual([HELD_LINE])
    const unreadable = tunnelListModel(tab({ unreadable: true }), noView)
    expect(unreadable.rows.every((one) => one.disabled)).toBe(true)
  })

  it('has no extensions line, which is a website\'s, and no line about an app\'s updates', () => {
    const list = notes(tab({ via: 'nym', following: false, tabChoice: 'nym' }, { extensionsOnSite: ['uBlock Origin'] }))
    expect(list.join(' ')).not.toContain('extensions')
    expect(list.join(' ')).not.toContain('updates')
  })
})

describe('the words about a tab', () => {
  it('say what changing the tunnel could not do in the tab\'s own words', () => {
    expect(TAB_TUNNEL_FAILED).toBe('The tunnel could not be changed for this tab.')
  })

  it('are nothing for a tab with no choice whose switches are fixed', () => {
    expect(tabNotes(tunnel, false, true)).toEqual([])
    expect(tabNotes({ ...tunnel, tabChoice: 'nym' }, false, true)).toHaveLength(2)
  })
})
