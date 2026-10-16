import { describe, expect, it } from 'vitest'
import { tunnelRowWords } from '../pages/settings/route-part.js'
import type { TunnelRowView } from '../pages/settings/route-part.js'
import { groupOf, REMOVE_STORAGE } from '../pages/settings/sections/route-list-row.js'

const site = (over: Partial<TunnelRowView>): TunnelRowView => ({ origin: 'https://news.example', kind: 'site', entry: 'nym', state: 'idle', profile: 'nym', apart: true, apartIn: ['nym'], ...over })

describe('what the tunnel list says about a row', () => {
  it('says a site that goes through a tunnel does, naming the tunnel and the profile it lives in', () => {
    expect(tunnelRowWords(site({}))).toBe('Through Nym: this site\'s traffic goes through it. It lives in your Nym profile.')
    expect(tunnelRowWords(site({ entry: 'socks5', profile: 'socks5', apartIn: ['socks5'] }))).toBe('Through your proxy: this site\'s traffic goes through it. It lives in your proxy profile.')
    expect(tunnelRowWords(site({ kind: 'app', profile: undefined, apart: false, apartIn: [] }))).toBe('Through Nym: this app\'s traffic goes through it.')
  })

  it('says its traffic is stopped, not sent directly, when the tunnel has no address or does not answer', () => {
    expect(tunnelRowWords(site({ state: 'no-proxy', entry: 'socks5', profile: 'socks5' }))).toContain('no address is set for it, so this site\'s traffic is stopped')
    expect(tunnelRowWords(site({ state: 'down' }))).toContain('Nym, but it is not answering')
  })

  it('says a site with no setting left keeps its storage in the profile, and one set off lives in the direct profile', () => {
    expect(tunnelRowWords(site({ entry: undefined, profile: undefined, state: 'off' }))).toBe('This site follows your browser\'s tunnel setting. What it stored in your Nym profile is kept.')
    expect(tunnelRowWords(site({ entry: undefined, profile: undefined, state: 'off', apartIn: ['nym', 'socks5'] }))).toContain('your Nym and proxy profile is kept')
    expect(tunnelRowWords(site({ entry: 'off', profile: 'direct', state: 'off', apartIn: ['direct'] }))).toBe('The tunnel is off for this site. It lives in your direct profile.')
  })

  it('names the button that clears a site\'s own storage as the owner worded it', () => {
    expect(REMOVE_STORAGE).toBe('Remove its separate storage')
  })
})

describe('the heading a row is listed under', () => {
  it('is the profile a website lives in or keeps storage in, and Apps for every installed app', () => {
    expect(groupOf(site({}))).toBe('nym')
    expect(groupOf(site({ entry: 'socks5', profile: 'socks5' }))).toBe('socks5')
    expect(groupOf(site({ entry: 'off', profile: 'direct' }))).toBe('direct')
    expect(groupOf(site({ entry: undefined, profile: undefined, apartIn: ['socks5'] }))).toBe('socks5')
    expect(groupOf(site({ kind: 'app' }))).toBe('apps')
  })
})
