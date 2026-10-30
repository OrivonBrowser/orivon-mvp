import { describe, expect, it } from 'vitest'
import type { SiteTunnel } from '../../main/permissions/site-info.js'
import { extensionsHint, storageNotice, SWARM_HINT, tunnelHint } from '../site-info/tunnel-view.js'

const base: SiteTunnel = { via: null, following: true, subject: 'site', blocked: {}, notices: { nym: 'nym' }, swarm: false, unreadable: false, defaultKind: 'nym', proxy: { address: '', users: { sites: 0, apps: 0, tabs: 0, everything: false } } }

// The DOM is covered by the end-to-end spec that switches a website on; these are the words.

describe('the notice before a website moves into a profile', () => {
  it('names Nym\'s profile the tunnel profile, in these words', () => {
    expect(storageNotice('nym')).toBe('This site moves to your tunnel profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.')
  })

  it('names the proxy\'s profile as the tunnel profile too', () => {
    expect(storageNotice('socks5')).toBe('This site moves to your tunnel profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.')
  })

  it('names the direct profile the same way', () => {
    expect(storageNotice('direct')).toBe('This site moves to your direct profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.')
  })
})

describe('the hint under the tunnel switch', () => {
  it('has nothing to add for an ordinary website', () => {
    expect(tunnelHint(base)).toBeUndefined()
    expect(tunnelHint({ ...base, via: 'nym' })).toBeUndefined()
  })

  it('has nothing to say about a tunnel that cannot be chosen: its row does', () => {
    expect(tunnelHint({ ...base, blocked: { socks5: 'no-proxy', nym: 'nym-off' } })).toBeUndefined()
  })

  it('says a Swarm address does not open while the tunnel is on for it, before and after the switch is turned on', () => {
    expect(tunnelHint({ ...base, swarm: true })).toBe(SWARM_HINT)
    expect(tunnelHint({ ...base, swarm: true, via: 'nym' })).toBe(SWARM_HINT)
  })

  it('says why the switch is fixed when the list of tunnel settings cannot be read', () => {
    expect(tunnelHint({ ...base, unreadable: true, via: 'nym' })).toContain('could not read your tunnel settings')
    expect(tunnelHint({ ...base, unreadable: true, via: 'nym' })).toContain('through Nym when that has no address')
  })
})

describe('the extensions a website in a profile keeps', () => {
  it('names them and says what stays with normal browsing', () => {
    expect(extensionsHint(['uBlock Origin', 'Dark Reader'], 'nym')).toBe('Your extensions run in the tunnel profile too: uBlock Origin, Dark Reader. Each profile keeps its own settings for them, and their side panels and keyboard shortcuts work only in your normal browsing.')
    expect(extensionsHint(['uBlock Origin'], 'direct')).toBe('Your extensions run in the direct profile too: uBlock Origin. They run only while a site of this profile is open. Each profile keeps its own settings for them, and their side panels and keyboard shortcuts work only in your normal browsing.')
    expect(extensionsHint(['Dark Reader'], 'direct')).toContain('direct profile')
  })

  it('says nothing when no extension reaches the site or the website is not in a profile', () => {
    expect(extensionsHint([], 'nym')).toBeUndefined()
    expect(extensionsHint(['Dark Reader'], undefined)).toBeUndefined()
  })
})
