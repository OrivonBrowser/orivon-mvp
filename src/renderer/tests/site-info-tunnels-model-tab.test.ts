import { describe, expect, it } from 'vitest'
import type { SiteInfo, SiteTunnel } from '../../main/permissions/site-info.js'
import { ALWAYS_LABEL, ALWAYS_LINE_HELD, ALWAYS_LINE_NOTHING, ALWAYS_LINE_OFF, ALWAYS_LINE_ON, TAB_TUNNEL_FAILED, alwaysLineOther, tabNotes } from '../site-info/tab-words.js'
import { HELD_LINE, NYM_OFF_LINE, tunnelListModel } from '../site-info/tunnels-model.js'

// The tunnels page when it is about a tab (ADR-0101): the same rows, the words of a tab, and no storage notice.

const tunnel: SiteTunnel = { via: null, following: true, subject: 'tab', blocked: {}, notices: {}, swarm: false, unreadable: false, defaultKind: 'nym', proxy: { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, tabs: 0, everything: false } } }
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

  it('says in one line that a direct tab goes direct and that a site saved to a tunnel keeps it, whether or not the browser is on a tunnel', () => {
    const words = 'Sites in this tab go direct. A site saved to a tunnel keeps it.'
    expect(notes(tab({ via: null, following: false, tabChoice: 'direct' }, { everywhere: true }))).toEqual([words])
    expect(notes(tab({ via: null, following: false, tabChoice: 'direct' }, { everywhere: false }))).toEqual([words])
  })

  it('does not say direct for a direct tab while the settings cannot be read: its sites go through the one tunnel all sites take', () => {
    const info = tab({ via: 'socks5', following: false, tabChoice: 'direct', unreadable: true }, { route: 'ok' })
    const model = tunnelListModel(info, noView)
    expect(row(model, 'socks5')).toMatchObject({ on: true, disabled: true })
    const text = model.notes.map((note) => note.text)
    expect(text.join(' ')).not.toContain('go direct')
    expect(text.join(' ')).not.toContain('direct profile')
    expect(text.join(' ')).toContain('could not read your tunnel settings')
    expect(tabNotes({ ...tunnel, tabChoice: 'direct', unreadable: true }, true)).toEqual([])
  })

  it('names the choice in one line, so a tab opened on a website still says what is set for every site in it', () => {
    expect(notes(tab({ via: 'nym', following: false, tabChoice: 'nym' }))).toEqual(['Sites in this tab go through Nym until the tab closes, with their sign-ins kept apart.'])
    expect(notes(tab({ via: 'socks5', following: false, tabChoice: 'socks5' }))).toEqual(['Sites in this tab go through your tunnel until the tab closes, with their sign-ins kept apart.'])
  })

  it('asks the person to pick, or says the tab follows the browser, in one line', () => {
    expect(notes(tab())).toEqual(['Pick a tunnel for the sites you open in this tab, until it closes.'])
    expect(notes(tab({ via: 'nym' }, { everywhere: true }))).toEqual(['This tab follows your browser-wide tunnel. Turn it off here for this tab only.'])
  })

  it('names no profile: where the sign-ins are kept is said once, as kept apart', () => {
    for (const choice of ['nym', 'socks5', 'direct'] as const) {
      const joined = notes(tab({ via: choice === 'direct' ? null : choice, following: false, tabChoice: choice })).join(' ')
      expect(joined).not.toContain('profile')
    }
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
    expect(tabNotes(tunnel, true)).toEqual([])
    expect(tabNotes({ ...tunnel, tabChoice: 'nym' }, true)).toHaveLength(1)
  })

  it('are at most one line, in every state a tab can be in', () => {
    const choices = [undefined, 'nym', 'socks5', 'direct'] as const
    const vias = [null, 'nym', 'socks5'] as const
    for (const tabChoice of choices) for (const via of vias) for (const on of [false, true]) for (const unreadable of [false, true]) for (const fixed of [false, true]) {
      const state = { ...tunnel, via, unreadable, ...(tabChoice === undefined ? {} : { tabChoice }), always: { on, available: true } }
      expect(tabNotes(state, fixed).length, JSON.stringify({ tabChoice, via, on, unreadable, fixed })).toBeLessThanOrEqual(1)
    }
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

  it('is on, and names both tunnels, while the tab goes another way than the one the website was saved with', () => {
    const line = (entry: 'nym' | 'socks5' | null, via: 'nym' | 'socks5' | null, tabChoice?: 'nym' | 'socks5' | 'direct'): string | undefined =>
      tunnelListModel(site({ via, following: false, ...(tabChoice === undefined ? {} : { tabChoice }), always: { on: true, available: true, entry } }), noView).always?.line
    expect(line('socks5', 'nym', 'nym')).toBe('Saved for this site: your tunnel. This tab uses Nym.')
    expect(line('nym', 'socks5', 'socks5')).toBe('Saved for this site: Nym. This tab uses your tunnel.')
    expect(line(null, 'nym', 'nym')).toBe('Saved for this site: direct. This tab uses Nym.')
    expect(line('nym', null, 'direct')).toBe('Saved for this site: Nym. This tab goes direct.')
    expect(alwaysLineOther('nym', null)).toBe('Saved for this site: Nym. This tab goes direct.')
  })

  it('says it is saved for every tab while the tab goes where the website was saved to go', () => {
    const line = (entry: 'nym' | 'socks5' | null, via: 'nym' | 'socks5' | null): string | undefined =>
      tunnelListModel(site({ via, following: false, always: { on: true, available: true, entry } }), noView).always?.line
    expect(line('nym', 'nym')).toBe(ALWAYS_LINE_ON)
    expect(ALWAYS_LINE_ON).toBe('Saved for this site, in every tab.')
    expect(line(null, null)).toBe(ALWAYS_LINE_ON)
    // An entry the panel does not name (a page built without one) keeps the plain line.
    expect(tunnelListModel(site({ via: 'nym', following: false, always: { on: true, available: true } }), noView).always?.line).toBe(ALWAYS_LINE_ON)
  })

  it('is held with the rows: in a window held to a tunnel and while the settings cannot be read, promising nothing it cannot keep', () => {
    const held = tunnelListModel(site({ always: { on: false, available: true } }, { tunnelHeld: 'nym' }), noView).always
    expect(held).toMatchObject({ disabled: true, line: ALWAYS_LINE_HELD })
    expect(ALWAYS_LINE_HELD).toBe('')
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
    expect(notes(site({ via: 'nym', following: false, always: { on: true, available: true } }))).toEqual(['This site uses Nym in every tab.'])
    expect(notes(site({ via: 'socks5', following: false, always: { on: true, available: true } }))).toEqual(['This site uses your tunnel in every tab.'])
    expect(notes(site({ via: null, following: false, always: { on: true, available: true } }))).toEqual(['This site goes direct in every tab.'])
    expect(notes(site({ via: 'nym', following: true }, { everywhere: true }))).toEqual(['This tab follows your browser-wide tunnel. Turn it off here for this tab only.'])
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
    expect(notes(site({ via: 'nym', following: false, tabChoice: 'nym', always: { on: true, available: true } }))).toEqual(['Sites in this tab go through Nym until the tab closes, with their sign-ins kept apart.'])
  })

  it('keeps the Swarm hint and the storage notices of the website', () => {
    const info = site({ swarm: true, notices: { nym: 'nym' } })
    expect(notes(info).join(' ')).toContain('Swarm')
    expect(info.tunnel?.notices).toEqual({ nym: 'nym' })
  })
})
