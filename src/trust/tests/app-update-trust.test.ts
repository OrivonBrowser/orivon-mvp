import { describe, expect, it } from 'vitest'
import { reasonText, updateTrust } from '../app-update-trust.js'
import type { UpdateTrustFacts } from '../app-update-trust.js'
import type { ProviderVerdict } from '../score-provider.js'

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'

function judged (level: number): ProviderVerdict {
  return { status: 'judged', provider: { name: 'P', address: 'x' }, evaluation: { id: `cid:${CID}`, name: 'App', version: undefined, evaluated: '2026-10-05', trustlessity: { level, privacy: level === 4 }, summary: undefined, operations: [], connections: [], evidence: [] } }
}

/** A facts object for which all five conditions hold; each test breaks one. */
function holding (overrides: Partial<UpdateTrustFacts> = {}): UpdateTrustFacts {
  return { verdict: judged(3), pinnedVerdict: judged(3), versionOrder: 1, newDomain: 'app.eth', originHost: 'app.eth', pointersVerified: true, ...overrides }
}

describe('updateTrust', () => {
  it('is verified only when all five conditions hold, and carries the judged level', () => {
    expect(updateTrust(holding())).toEqual({ verified: true, level: 3 })
  })

  it('verifies a Level 2 evaluation: Attila judges the first ports Level 2', () => {
    expect(updateTrust(holding({ verdict: judged(2), pinnedVerdict: judged(2) }))).toEqual({ verified: true, level: 2 })
  })

  it('does not need the pinned build to have an evaluation', () => {
    expect(updateTrust(holding({ pinnedVerdict: { status: 'no-score', provider: { name: 'P', address: 'x' } } }))).toEqual({ verified: true, level: 3 })
  })

  it.each([
    ['no provider chosen', { verdict: { status: 'off' } }, 'no-provider'],
    ['no score for the new CID', { verdict: { status: 'no-score', provider: { name: 'P', address: 'x' } } }, 'no-score'],
    ['a provider that did not answer', { verdict: { status: 'unreachable', address: 'x', reason: 'down' } }, 'provider-unreachable'],
    ['a lookup that is still pending', { verdict: { status: 'pending', address: 'x' } }, 'provider-unreachable'],
    ['an evaluation lower than the pinned one', { verdict: judged(2), pinnedVerdict: judged(3) }, 'lower-level'],
    ['a version no newer than the floor', { versionOrder: 0 }, 'not-newer'],
    ['a version that does not order against the floor', { versionOrder: null }, 'not-newer'],
    ['a version below the floor', { versionOrder: -1 }, 'not-newer'],
    ['a manifest naming another domain', { newDomain: 'other.eth' }, 'other-home'],
    ['a manifest naming no domain', { newDomain: undefined }, 'other-home'],
    ['a name whose pointers were not verified', { pointersVerified: false }, 'unproven-name']
  ] as const)('is not verified for %s, and says only that', (_label, overrides, reason) => {
    expect(updateTrust(holding(overrides as Partial<UpdateTrustFacts>))).toEqual({ verified: false, reasons: [reason] })
  })

  it('is never verified at a key address, whatever the manifest names, and says why', () => {
    const key = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8.ipns.orivon'
    expect(updateTrust(holding({ originHost: key, newDomain: 'app.eth' }))).toEqual({ verified: false, reasons: ['key-address'] })
    expect(updateTrust(holding({ originHost: key, newDomain: undefined }))).toEqual({ verified: false, reasons: ['key-address'] })
    expect(reasonText('key-address', 'app.eth')).toMatch(/reached at a key/)
  })

  it('lists every reason that fails, in a fixed order', () => {
    expect(updateTrust(holding({ verdict: { status: 'off' }, versionOrder: 0, pointersVerified: false }))).toEqual({ verified: false, reasons: ['no-provider', 'not-newer', 'unproven-name'] })
  })
})

describe('reasonText', () => {
  it('says each reason in a sentence a person can act on', () => {
    expect(reasonText('no-provider', undefined)).toMatch(/No Web3 Score provider is chosen/)
    expect(reasonText('other-home', 'other.eth')).toMatch(/names other\.eth as its home/)
    expect(reasonText('other-home', undefined)).toMatch(/names no home/)
    expect(reasonText('not-newer', undefined)).toMatch(/not newer/)
  })
})
