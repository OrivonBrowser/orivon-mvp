import { describe, expect, it } from 'vitest'
import type { SiteTunnel } from '../../main/permissions/site-info.js'
import { extensionsHint, STORAGE_NOTICE, tunnelHint } from '../site-info/tunnel-view.js'

const base: SiteTunnel = { on: false, needsNotice: true, web3: false, unreadable: false }

// The DOM is covered by the end-to-end spec that switches a website on; these are the words.

describe('the notice before a website moves into storage of its own', () => {
  it('says what the owner decided, in these words', () => {
    expect(STORAGE_NOTICE).toBe('This site gets its own storage. You\'ll sign in to it again once, and what it stores stays apart from the rest of your browsing.')
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

describe('the extensions a tunnelled site loses', () => {
  it('names them, because extensions load into the shared session', () => {
    expect(extensionsHint(['uBlock Origin', 'Dark Reader'])).toBe('Extensions do not run on a site that goes through the tunnel: uBlock Origin, Dark Reader.')
  })

  it('says nothing when no extension reaches the site', () => {
    expect(extensionsHint([])).toBeUndefined()
  })
})
