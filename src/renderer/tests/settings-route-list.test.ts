import { describe, expect, it } from 'vitest'
import { tunnelRowWords } from '../pages/settings/route-part.js'
import type { TunnelRowView } from '../pages/settings/route-part.js'
import { REMOVE_STORAGE } from '../pages/settings/sections/route-list-row.js'

const site = (over: Partial<TunnelRowView>): TunnelRowView => ({ origin: 'https://news.example', kind: 'site', entry: 'on', state: 'idle', profile: 'tunnel', apart: true, apartIn: ['tunnel'], ...over })

describe('what the tunnel list says about a row', () => {
  it('says a site that is on goes through the tunnel', () => {
    expect(tunnelRowWords(site({}))).toBe('On: this site\'s traffic goes through your tunnel. It lives in your tunnel profile.')
    expect(tunnelRowWords(site({ kind: 'app', profile: undefined, apart: false, apartIn: [] }))).toBe('On: this app\'s traffic goes through your tunnel.')
  })

  it('says its traffic is stopped, not sent directly, when no tunnel is set or it does not answer', () => {
    expect(tunnelRowWords(site({ state: 'no-proxy' }))).toContain('stopped')
    expect(tunnelRowWords(site({ state: 'down' }))).toContain('not answering')
  })

  it('says a site with no setting left keeps its storage in the profile, and one set off lives in the direct profile', () => {
    expect(tunnelRowWords(site({ entry: undefined, profile: undefined, state: 'off' }))).toBe('This site follows your browser\'s tunnel setting. What it stored in your tunnel profile is kept.')
    expect(tunnelRowWords(site({ entry: 'off', profile: 'direct', state: 'off', apartIn: ['direct'] }))).toBe('The tunnel is off for this site. It lives in your direct profile.')
  })

  it('names the button that clears a site\'s own storage as the owner worded it', () => {
    expect(REMOVE_STORAGE).toBe('Remove its separate storage')
  })
})
