import { describe, expect, it } from 'vitest'
import type { SiteTunnel } from '../../main/permissions/site-info.js'
import { extensionsHint, storageNotice, tunnelHint } from '../site-info/tunnel-view.js'

const base: SiteTunnel = { on: false, notice: 'tunnel', web3: false, unreadable: false }

// The DOM is covered by the end-to-end spec that switches a website on; these are the words.

describe('the notice before a website moves into a profile', () => {
  it('names the tunnel profile, in these words', () => {
    expect(storageNotice('tunnel')).toBe('This site moves to your tunnel profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.')
  })

  it('names the direct profile the same way', () => {
    expect(storageNotice('direct')).toBe('This site moves to your direct profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.')
  })
})

describe('the hint under the tunnel switch', () => {
  it('has nothing to add for an ordinary website', () => {
    expect(tunnelHint(base)).toBeUndefined()
    expect(tunnelHint({ ...base, on: true })).toBeUndefined()
  })

  it('says to set a tunnel first when there is none and the switch is off', () => {
    expect(tunnelHint({ ...base, blocked: 'no-proxy' })).toBe('Set a tunnel under Privacy and data first.')
    expect(tunnelHint({ ...base, blocked: 'no-proxy', on: true })).toBeUndefined()
  })

  it('says a Web3 name\'s own files stay outside the tunnel before the switch is turned on', () => {
    expect(tunnelHint({ ...base, web3: true })).toBe('A Web3 name\'s own files come from Orivon itself and stay outside the tunnel for now.')
  })

  it('says why the switch is fixed when the list of tunnel settings cannot be read', () => {
    expect(tunnelHint({ ...base, unreadable: true, on: true })).toContain('could not read your tunnel settings')
  })
})

describe('the extensions a website in a profile keeps', () => {
  it('names them and says what stays with normal browsing', () => {
    expect(extensionsHint(['uBlock Origin', 'Dark Reader'], 'tunnel')).toBe('Your extensions run in the tunnel profile too: uBlock Origin, Dark Reader. Their toolbar buttons and popups, and any blocker that works through the browser\'s request API, stay with your normal browsing.')
    expect(extensionsHint(['Dark Reader'], 'direct')).toContain('direct profile')
  })

  it('says nothing when no extension reaches the site or the website is not in a profile', () => {
    expect(extensionsHint([], 'tunnel')).toBeUndefined()
    expect(extensionsHint(['Dark Reader'], undefined)).toBeUndefined()
  })
})
