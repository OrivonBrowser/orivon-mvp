import { describe, expect, it } from 'vitest'
import type { UpdateOffer } from '../../install/app-updates.js'
import { describeFailedUpdate, describeForceUpdate, describeUnverifiedUpdate, describeVerifiedUpdate } from '../update-available-render.js'

const ORIGIN = 'https://thelounge.orivonstack.eth'

function offer (overrides: Partial<UpdateOffer> = {}): UpdateOffer {
  return { origin: ORIGIN, fromCid: 'a', toCid: 'b', fromVersion: '0.25.3', toVersion: '0.25.3.1', claimedName: 'The Lounge', level: 2, verified: true, reasons: [], newDomain: 'thelounge.orivonstack.eth', ...overrides }
}

describe('describeVerifiedUpdate', () => {
  it('asks whether to switch, and gives both versions and the level', () => {
    const content = describeVerifiedUpdate(offer())
    expect(content.message).toBe('ipfs://thelounge.orivonstack.eth has updated the app to a new version. Do you want to switch to the new version?')
    expect(content.detail).toContain('Version 0.25.3 to 0.25.3.1.')
    expect(content.detail).toContain('Level 2')
    expect(content.detail).toContain('Claims to be "The Lounge".')
    expect(content.warning).toBe(false)
  })

  it('names no version it does not know', () => {
    expect(describeVerifiedUpdate(offer({ fromVersion: undefined })).detail).toContain('Version 0.25.3.1.')
  })
})

describe('describeUnverifiedUpdate', () => {
  it('says the score is not verified, points at the key icon and gives each reason', () => {
    const content = describeUnverifiedUpdate(offer({ verified: false, level: undefined, reasons: ['no-score', 'other-home'], newDomain: 'other.eth' }))
    expect(content.message).toMatch(/Its Web3 Score has not been verified yet\. To switch, open the key icon and choose Trust & Force update\./)
    expect(content.detail).toContain('no evaluation of this exact version')
    expect(content.detail).toContain('names other.eth as its home')
    expect(content.message).toContain('has updated the app to a new version')
  })

  it('does not call an older or equal version a new one', () => {
    const content = describeUnverifiedUpdate(offer({ verified: false, reasons: ['not-newer'] }))
    expect(content.message).toContain('now points at another version of the app')
    expect(content.message).not.toContain('a new version')
  })
})

describe('describeForceUpdate', () => {
  it('lists what carries over and warns', () => {
    const content = describeForceUpdate(offer({ verified: false, reasons: ['no-provider'] }), ['Connect to api.example.com', 'Store files'])
    expect(content.warning).toBe(true)
    expect(content.detail).toContain('- Connect to api.example.com')
    expect(content.detail).toContain('- Store files')
    expect(content.detail).toMatch(/its data/i)
  })

  it('says so when nothing was granted', () => {
    expect(describeForceUpdate(offer({ verified: false }), []).detail).toMatch(/no grants/i)
  })
})

describe('describeFailedUpdate', () => {
  it('says why, and that the version in use keeps running', () => {
    const content = describeFailedUpdate(offer(), 'the gateway did not answer')
    expect(content.message).toContain('the gateway did not answer')
    expect(content.message).toMatch(/keeps running/)
  })
})

describe('every sentence is plain ASCII', () => {
  it('has no character outside ASCII in any composed text', () => {
    const o = offer({ verified: false, reasons: ['no-provider', 'no-score', 'provider-unreachable', 'lower-level', 'not-newer', 'other-home', 'unproven-name'] })
    for (const content of [describeVerifiedUpdate(o), describeUnverifiedUpdate(o), describeForceUpdate(o, ['x']), describeFailedUpdate(o, 'y')]) {
      expect(`${content.title}${content.message}${content.detail}`).toMatch(/^[\x20-\x7e\n]*$/)
    }
  })
})
