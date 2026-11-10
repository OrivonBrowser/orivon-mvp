import { describe, expect, it } from 'vitest'
import { addressOf, followsChange, identityOf, planSet, sameCookie, siteOfCookie, wouldSend } from '../cookies.js'
import { signIn } from './fake-cookie-store.test-helpers.js'

const NOW = 1_800_000_000

describe('planning one cookie for another session', () => {
  it('keeps every attribute, and a host-only cookie stays host-only by having no domain', () => {
    expect(planSet(signIn({ expirationDate: NOW + 1000 }), NOW)).toEqual({
      kind: 'set',
      cookie: { url: 'https://example.com/', name: 'sid', value: 'one', path: '/', secure: true, httpOnly: true, expirationDate: NOW + 1000, sameSite: 'lax' }
    })
  })

  it('gives a domain cookie its domain, and builds its address from the domain without the dot and from its path', () => {
    const plan = planSet(signIn({ domain: '.example.com', hostOnly: false, path: '/app', secure: false, httpOnly: false, sameSite: 'no_restriction' }), NOW)
    expect(plan).toMatchObject({ kind: 'set', cookie: { url: 'https://example.com/app', domain: '.example.com', path: '/app', secure: false, httpOnly: false, sameSite: 'no_restriction' } })
  })

  it('leaves out the expiry of a session cookie, so it stays one', () => {
    const { expirationDate: _gone, ...rest } = signIn()
    const plan = planSet({ ...rest, session: true }, NOW)
    expect(plan.kind === 'set' && 'expirationDate' in plan.cookie).toBe(false)
  })

  it('does not carry a cookie that has expired, or one with no domain to set it for', () => {
    expect(planSet(signIn({ expirationDate: NOW - 1 }), NOW)).toEqual({ kind: 'skip', reason: 'expired' })
    const { domain: _domain, ...bare } = signIn()
    expect(planSet(bare, NOW)).toEqual({ kind: 'skip', reason: 'no domain' })
  })

  it('writes an IPv6 host in brackets', () => {
    expect(planSet(signIn({ domain: '::1' }), NOW)).toMatchObject({ kind: 'set', cookie: { url: 'https://[::1]/' } })
  })
})

describe('the address a cookie is removed by', () => {
  it('keeps a ? or # in the path from ending the address there', () => {
    expect(addressOf(signIn({ path: '/a?b#c' }))).toBe('https://example.com/a%3Fb%23c')
  })
})

describe('which cookies a removal by address takes along', () => {
  const address = 'https://example.com/app/page'
  it('takes the host\'s own cookies and those of a parent domain, on a path the address is under', () => {
    expect(wouldSend(signIn({ path: '/' }), address)).toBe(true)
    expect(wouldSend(signIn({ path: '/app' }), address)).toBe(true)
    expect(wouldSend(signIn({ path: '/app/' }), address)).toBe(true)
    expect(wouldSend(signIn({ domain: '.example.com', hostOnly: false }), 'https://api.example.com/')).toBe(true)
  })

  it('leaves cookies of another host, a sibling path, a subdomain of a host-only cookie, or a name-sharing path prefix', () => {
    expect(wouldSend(signIn({ domain: 'other.test' }), address)).toBe(false)
    expect(wouldSend(signIn({ path: '/other' }), address)).toBe(false)
    expect(wouldSend(signIn({ path: '/ap' }), address)).toBe(false)
    expect(wouldSend(signIn(), 'https://api.example.com/')).toBe(false)
    expect(wouldSend(signIn({ domain: '.example.com', hostOnly: false }), 'https://notexample.com/')).toBe(false)
  })

  it('leaves a secure cookie out of an address that is not https, and a bad address or a cookie with no domain out of everything', () => {
    expect(wouldSend(signIn({ secure: true }), 'http://example.com/')).toBe(false)
    expect(wouldSend(signIn(), 'not an address')).toBe(false)
    const { domain: _domain, ...bare } = signIn()
    expect(wouldSend(bare, address)).toBe(false)
  })
})

describe('which cookie is which', () => {
  it('tells cookies apart by name, domain and path, and a host-only cookie from a domain cookie of the same host', () => {
    const base = signIn()
    expect(identityOf(base)).toBe(identityOf({ ...base, value: 'other', secure: false }))
    expect(identityOf(base)).not.toBe(identityOf({ ...base, name: 'other' }))
    expect(identityOf(base)).not.toBe(identityOf({ ...base, path: '/x' }))
    expect(identityOf(base)).not.toBe(identityOf({ ...base, domain: 'api.example.com' }))
    expect(identityOf(base)).not.toBe(identityOf({ ...base, domain: '.example.com', hostOnly: false }))
  })

  it('does not tell a leading dot or a capital from the same host', () => {
    expect(identityOf(signIn({ domain: '.Example.com', hostOnly: false }))).toBe(identityOf(signIn({ domain: 'example.com', hostOnly: false })))
  })
})

describe('whether two cookies are the same cookie', () => {
  it('is true for the same value and attributes, whatever else differs by a rounding of the expiry', () => {
    expect(sameCookie(signIn(), signIn({ expirationDate: 4_000_000_000.4 }))).toBe(true)
  })

  it('is false when the value, an attribute, the expiry or being a session cookie differs', () => {
    const base = signIn()
    expect(sameCookie(base, signIn({ value: 'two' }))).toBe(false)
    expect(sameCookie(base, signIn({ secure: false }))).toBe(false)
    expect(sameCookie(base, signIn({ httpOnly: false }))).toBe(false)
    expect(sameCookie(base, signIn({ sameSite: 'strict' }))).toBe(false)
    expect(sameCookie(base, signIn({ expirationDate: 4_000_000_100 }))).toBe(false)
    const { expirationDate: _gone, ...rest } = base
    expect(sameCookie(base, { ...rest, session: true })).toBe(false)
  })

  it('reads an unstated same-site as unspecified', () => {
    const { sameSite: _gone, ...rest } = signIn()
    expect(sameCookie(rest, signIn({ sameSite: 'unspecified' }))).toBe(true)
  })
})

describe('which changes a mirror follows', () => {
  it('follows an insert, a change of attributes, a removal by the site or a person, and a deletion by an already-expired cookie', () => {
    expect(followsChange('inserted', false)).toBe(true)
    expect(followsChange('inserted-no-value-change-overwrite', false)).toBe(true)
    expect(followsChange('explicit', true)).toBe(true)
    expect(followsChange('expired-overwrite', true)).toBe(true)
  })

  it('does not follow the removal half of an overwrite, a cookie that ran out, one that was evicted, or an insert that changed nothing', () => {
    expect(followsChange('overwrite', true)).toBe(false)
    expect(followsChange('expired', true)).toBe(false)
    expect(followsChange('evicted', true)).toBe(false)
    expect(followsChange('inserted-no-change-overwrite', false)).toBe(false)
  })
})

describe('the site a cookie belongs to', () => {
  const siteOfDomain = (domain: string): string | undefined => siteOfCookie({ domain })

  it('is the registrable domain, and a host or domain cookie of any host under it is the same site', () => {
    expect(siteOfDomain('example.com')).toBe('example.com')
    expect(siteOfDomain('.www.example.com')).toBe('example.com')
    expect(siteOfDomain('cdn.shop.example.co.uk')).toBe('example.co.uk')
    expect(siteOfCookie({})).toBeUndefined()
  })

  it('tells the customers of a service that hands out domains apart: the private section of the public suffix list counts', () => {
    expect(siteOfDomain('alice.github.io')).toBe('alice.github.io')
    expect(siteOfDomain('bob.github.io')).toBe('bob.github.io')
    expect(siteOfDomain('d111111abcdef8.cloudfront.net')).toBe('d111111abcdef8.cloudfront.net')
    expect(siteOfDomain('bucket-a.s3.amazonaws.com')).not.toBe(siteOfDomain('bucket-b.s3.amazonaws.com'))
    expect(siteOfDomain('vitalik.eth.limo')).toBe('vitalik.eth.limo')
  })

  it('is the whole host for an address Orivon serves, whose parent is a namespace shared by many parties', () => {
    expect(siteOfDomain('bafyone.ipfs.orivon')).toBe('bafyone.ipfs.orivon')
    expect(siteOfDomain('.bafytwo.ipfs.orivon')).toBe('bafytwo.ipfs.orivon')
    expect(siteOfDomain('feed.bzz.orivon')).toBe('feed.bzz.orivon')
    expect(siteOfDomain('vitalik.eth')).toBe('vitalik.eth')
    expect(siteOfDomain('www.vitalik.eth')).toBe('www.vitalik.eth')
    expect(siteOfDomain('alice.base.eth')).toBe('alice.base.eth')
    expect(siteOfDomain('bob.base.eth')).toBe('bob.base.eth')
    expect(siteOfDomain('base.eth')).toBe('base.eth')
  })

  it('is the host itself for an address with no registrable domain', () => {
    expect(siteOfDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(siteOfDomain('localhost')).toBe('localhost')
    expect(siteOfDomain('::1')).toBe('::1')
  })
})
