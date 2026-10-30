import { describe, expect, it } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { ALWAYS_LABEL, ALWAYS_LINE_NOTHING, ALWAYS_LINE_OFF, ALWAYS_LINE_ON, SITE_OWN_DIRECT_NOTE, TAB_DIRECT_PROFILE_NOTE, TAB_FOLLOWING_NOTE, TAB_PICK_NOTE, TAB_TUNNEL_FAILED, TAB_TUNNEL_PROFILE_NOTE, directTabNote, tabNotes } from '../site-info/tab-words.js'
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

  it('says that a site with a tunnel of its own keeps it in a direct tab, which a direct choice leaves it', () => {
    const list = notes(tab({ via: null, following: false, tabChoice: 'direct' }, { everywhere: true }))
    expect(TAB_DIRECT_PROFILE_NOTE).toContain('A site that has a tunnel of its own keeps it.')
    expect(list).toContain(TAB_DIRECT_PROFILE_NOTE)
  })

  it('does not say direct for a direct tab while the settings cannot be read: its sites go through the one tunnel all sites take', () => {
    const info = tab({ via: 'socks5', following: false, tabChoice: 'direct', unreadable: true }, { route: 'ok' })
    const model = tunnelListModel(info, noView)
    expect(row(model, 'socks5')).toMatchObject({ on: true, disabled: true })
    const text = model.notes.map((note) => note.text)
    expect(text.join(' ')).not.toContain('Direct for this tab')
    expect(text.join(' ')).not.toContain('direct profile')
    expect(text.join(' ')).toContain('could not read your tunnel settings')
    expect(tabNotes({ ...tunnel, tabChoice: 'direct', unreadable: true }, false, true)).toEqual([])
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

describe('the tunnels page of a tab showing a website', () => {
  const ORIGIN = 'https://news.example'
  const site = (patch: Partial<SiteTunnel> = {}, rest: Partial<SiteInfo> = {}): SiteInfo => tab({ always: { on: false, available: false }, ...patch }, { origin: ORIGIN, ...rest })

  it('has no "Always" switch on a tab that shows no website, and on a page that is not about the tab', () => {
    expect(tunnelListModel(tab(), noView).always).toBeNull()
    expect(tunnelListModel(tab({ subject: 'site' }), noView).always).toBeNull()
  })

  it('has it under the rows, labelled for the site, off and held while nothing is chosen', () => {
    const always = tunnelListModel(site(), noView).always
    expect(always).toEqual({ label: ALWAYS_LABEL, line: ALWAYS_LINE_NOTHING, on: false, disabled: true })
    expect(ALWAYS_LABEL).toBe('Always use for this site')
  })

  it('is free to move once the tab has a choice to keep, and says what it does', () => {
    const always = tunnelListModel(site({ via: 'nym', following: false, tabChoice: 'nym', always: { on: false, available: true } }), noView).always
    expect(always).toEqual({ label: ALWAYS_LABEL, line: ALWAYS_LINE_OFF, on: false, disabled: false })
    expect(ALWAYS_LINE_OFF).toBe('Keeps this choice after the tab closes.')
  })

  it('is on while the website has an entry of its own, and can be turned off', () => {
    const always = tunnelListModel(site({ via: 'nym', following: false, always: { on: true, available: true } }), noView).always
    expect(always).toEqual({ label: ALWAYS_LABEL, line: ALWAYS_LINE_ON, on: true, disabled: false })
  })

  it('is held with the rows: in a window held to a tunnel and while the settings cannot be read, still saying what it would do', () => {
    const held = tunnelListModel(site({ always: { on: false, available: false } }, { tunnelHeld: 'nym' }), noView).always
    expect(held).toMatchObject({ disabled: true, line: ALWAYS_LINE_OFF })
    const unreadable = tunnelListModel(site({ unreadable: true, always: { on: true, available: true } }), noView).always
    expect(unreadable).toMatchObject({ on: true, disabled: true })
  })

  it('is held while the storage question is open, so the question is answered before anything else is changed', () => {
    const open = { pending: 'nym' as const }
    expect(tunnelListModel(site({ via: null, always: { on: false, available: true }, tabChoice: 'direct', following: false }), open).always?.disabled).toBe(true)
  })

  it('lights what the page really does, and keeps the extensions note a website\'s own panel gives', () => {
    const model = tunnelListModel(site({ via: 'socks5', following: false, profile: 'socks5', always: { on: true, available: true } }, { extensionsOnSite: ['Ad Blocker'] }), noView)
    expect(model.rows.map((one) => one.on)).toEqual([false, true])
    expect(model.notes.map((note) => note.text).join(' ')).toContain('Your extensions run in the tunnel profile too: Ad Blocker.')
  })

  it('does not say the tab follows the browser for a website that has a tunnel of its own', () => {
    expect(notes(site({ via: 'nym', following: false, always: { on: true, available: true } }))).toEqual(['This site goes through Nym in every tab, because you chose it for the site.'])
    expect(notes(site({ via: 'socks5', following: false, always: { on: true, available: true } }))).toEqual(['This site goes through your tunnel in every tab, because you chose it for the site.'])
    expect(notes(site({ via: null, following: false, always: { on: true, available: true } }))).toEqual([SITE_OWN_DIRECT_NOTE])
    expect(notes(site({ via: 'nym', following: true }, { everywhere: true }))).toEqual([TAB_FOLLOWING_NOTE])
  })

  it('names the website, not the tab, in the line of a tunnel the website has but the tab did not choose', () => {
    const live = { route: 'ok', nym: { state: 'off' } } as const
    const own = tunnelListModel(site({ via: 'nym', following: false, always: { on: true, available: true } }, live), noView)
    expect(row(own, 'nym')?.state.text).toBe('This site\'s traffic goes through Nym.')
    const chosen = tunnelListModel(site({ via: 'nym', following: false, tabChoice: 'nym', always: { on: true, available: true } }, live), noView)
    expect(row(chosen, 'nym')?.state.text, 'a tab that chose speaks for its sites').toBe('This tab\'s traffic goes through Nym.')
    const following = tunnelListModel(site({ via: 'nym', following: true }, { ...live, everywhere: true }), noView)
    expect(row(following, 'nym')?.state.text).toBe('This tab\'s traffic goes through Nym.')
  })

  it('says what a tab\'s choice means for every site it opens, whether or not this one keeps it', () => {
    expect(notes(site({ via: 'nym', following: false, tabChoice: 'nym', always: { on: true, available: true } }))).toEqual(['Every site you open in this tab goes through Nym, until the tab is closed.', TAB_TUNNEL_PROFILE_NOTE])
  })

  it('keeps the Swarm hint and the storage notices of the website', () => {
    const info = site({ swarm: true, notices: { nym: 'nym' } })
    expect(notes(info).join(' ')).toContain('Swarm')
    expect(info.tunnel?.notices).toEqual({ nym: 'nym' })
  })
})
