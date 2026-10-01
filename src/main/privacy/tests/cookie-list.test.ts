import { describe, expect, it } from 'vitest'
import { cookieKey, cookiesForSite, cookiesOfDomain, displayText, removalUrl, viewOf, viewsOf } from '../cookie-list.js'
import type { CookieLike } from '../cookie-list.js'

const c = (name: string, domain: string, extra: Partial<CookieLike> = {}): CookieLike => ({ name, domain, path: '/', ...extra })

describe('the cookies a page on a host can see', () => {
  const all = [
    c('own', 'www.shop.example'),
    c('parent', '.shop.example'),
    c('apex', 'shop.example'),
    c('sibling', 'cdn.shop.example'),
    c('child', 'a.www.shop.example'),
    c('other', '.other.example'),
    c('lookalike', 'notshop.example')
  ]

  it('takes its own host and its parent domains, and nothing else', () => {
    expect(cookiesForSite(all, 'www.shop.example').map((cookie) => cookie.name)).toEqual(['own', 'parent', 'apex'])
  })

  it('leaves a sibling subdomain, a child host, another site and a look-alike suffix out', () => {
    const names = cookiesForSite(all, 'www.shop.example').map((cookie) => cookie.name)
    for (const name of ['sibling', 'child', 'other', 'lookalike']) expect(names).not.toContain(name)
  })

  it('never reaches above the registrable domain, so a public suffix cookie is not the site\'s', () => {
    expect(cookiesForSite([c('suffix', '.example')], 'shop.example')).toEqual([])
  })

  it('reads an IP address and localhost as the host itself', () => {
    const local = [c('a', '127.0.0.1'), c('b', 'localhost'), c('c', '10.0.0.1')]
    expect(cookiesForSite(local, '127.0.0.1').map((cookie) => cookie.name)).toEqual(['a'])
    expect(cookiesForSite(local, 'localhost').map((cookie) => cookie.name)).toEqual(['b'])
  })

  it('ignores a cookie with no domain', () => {
    expect(cookiesForSite([{ name: 'x' }], 'shop.example')).toEqual([])
  })

  it('lists every cookie of a registrable domain for the all-sites list', () => {
    expect(cookiesOfDomain(all, 'shop.example').map((cookie) => cookie.name)).toEqual(['own', 'parent', 'apex', 'sibling', 'child'])
  })
})

describe('a cookie as the person sees it', () => {
  it('has a key that is the same for the same cookie and differs by name, path and domain', () => {
    const base = c('a', '.x.example')
    expect(cookieKey(base)).toBe(cookieKey({ ...base, value: 'other' } as CookieLike))
    expect(cookieKey(base)).toMatch(/^[0-9a-f]{16}$/)
    expect(new Set([cookieKey(base), cookieKey({ ...base, name: 'b' }), cookieKey({ ...base, path: '/p' }), cookieKey({ ...base, domain: 'x.example' })]).size).toBe(4)
  })

  it('carries the flags and no value', () => {
    const view = viewOf({ ...c('sid', '.x.example'), secure: true, httpOnly: true, expirationDate: 1_800_000_000, value: 'hunter2' } as CookieLike)
    expect(view).toMatchObject({ name: 'sid', domain: '.x.example', secure: true, httpOnly: true, session: false, expires: 1_800_000_000 })
    expect(JSON.stringify(view)).not.toContain('hunter2')
  })

  it('is a session cookie with no expiry when it has no date or says so', () => {
    expect(viewOf(c('a', 'x.example'))).toMatchObject({ session: true, expires: null })
    expect(viewOf(c('a', 'x.example', { session: true, expirationDate: 5 }))).toMatchObject({ session: true, expires: null })
  })

  it('sorts by domain, then name', () => {
    expect(viewsOf([c('b', 'b.example'), c('z', 'a.example'), c('a', 'a.example')]).map((view) => `${view.domain}/${view.name}`)).toEqual(['a.example/a', 'a.example/z', 'b.example/b'])
  })

  it('draws control and direction characters as question marks and bounds the length', () => {
    expect(displayText('a\u0000b\nc‮d⁦')).toBe('a?b?c?d?')
    expect(displayText('x'.repeat(500)).length).toBe(200)
    expect(viewOf(c('evil‮name', 'x.example')).name).toBe('evil?name')
  })
})

describe('the address a removal names', () => {
  it('uses https for a Secure cookie and http for another, with its host and path', () => {
    expect(removalUrl({ ...c('a', '.x.example'), secure: true, path: '/app' })).toBe('https://x.example/app')
    expect(removalUrl(c('a', 'x.example'))).toBe('http://x.example/')
  })

  it('brackets an IPv6 host', () => {
    expect(removalUrl(c('a', '::1'))).toBe('http://[::1]/')
  })
})
