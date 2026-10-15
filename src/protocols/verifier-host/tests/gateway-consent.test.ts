import { describe, expect, it } from 'vitest'
import { CONSENT_LIFE_MS, GatewayConsent } from '../gateway-consent.js'

const SITE = 'https://a.eth'

describe('the gateway consent', () => {
  it('knows no site until the person says yes for it, and no request without a page', () => {
    const consent = new GatewayConsent()
    expect(consent.take(SITE)).toBe(false)
    expect(consent.take(undefined)).toBe(false)
  })

  it('gives a yes for the site whose page gave the token, to one load, and to that site alone', () => {
    const consent = new GatewayConsent()
    expect(consent.grant(SITE, consent.tokenFor(SITE))).toBe(true)
    expect(consent.take('https://b.eth')).toBe(false)
    expect(consent.take(SITE)).toBe(true)
    // Used up: the next load asks again.
    expect(consent.take(SITE)).toBe(false)
  })

  it('asks again for a second press, and forgets a yes no load used', () => {
    let now = 1_000
    const consent = new GatewayConsent(() => now)
    consent.grant(SITE, consent.tokenFor(SITE))
    now += CONSENT_LIFE_MS + 1
    expect(consent.take(SITE)).toBe(false)
    consent.grant(SITE, consent.tokenFor(SITE))
    expect(consent.take(SITE)).toBe(true)
  })

  it('refuses a token made for another site, a forged one, a missing one and a request with no site', () => {
    const consent = new GatewayConsent()
    expect(consent.grant(SITE, consent.tokenFor('https://b.eth'))).toBe(false)
    expect(consent.grant(SITE, 'forged')).toBe(false)
    expect(consent.grant(SITE, null)).toBe(false)
    expect(consent.grant(undefined, consent.tokenFor(SITE))).toBe(false)
    expect(consent.take(SITE)).toBe(false)
  })

  it('does not honour a token from another run of the host', () => {
    const earlier = new GatewayConsent()
    const later = new GatewayConsent()
    expect(later.grant(SITE, earlier.tokenFor(SITE))).toBe(false)
  })
})
