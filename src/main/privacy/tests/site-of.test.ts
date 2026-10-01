import { describe, expect, it } from 'vitest'
import { sameSite, siteOf } from '../site-of.js'

describe('siteOf', () => {
  it.each([
    ['https://shop.example/cart', 'shop.example'],
    ['https://www.shop.example:8443/a?b=c#d', 'shop.example'],
    ['http://a.b.c.shop.example', 'shop.example'],
    ['https://news.bbc.co.uk/', 'bbc.co.uk'],
    ['https://vitalik.eth/', 'vitalik.eth'],
    ['https://blog.vitalik.eth/', 'vitalik.eth'],
    ['HTTPS://WWW.Shop.Example/', 'shop.example'],
    ['wss://live.shop.example/socket', 'shop.example']
  ])('reduces %s to %s', (url, site) => {
    expect(siteOf(url)).toBe(site)
  })

  it('treats a domain a service hands to its customers as one site, not as a suffix', () => {
    expect(siteOf('https://alice.github.io/')).toBe('github.io')
    expect(siteOf('https://bob.github.io/')).toBe('github.io')
  })

  it.each([
    ['http://127.0.0.1:8080/x', '127.0.0.1'],
    ['http://[::1]:3000/', '::1'],
    ['http://192.168.0.10/', '192.168.0.10'],
    ['http://localhost:5173/', 'localhost'],
    ['http://app.localhost:8080/', 'app.localhost'],
    ['http://intranet/', 'intranet']
  ])('keeps the host of %s as %s', (url, host) => {
    expect(siteOf(url)).toBe(host)
  })

  it('answers null for what has no host', () => {
    for (const url of ['', 'not a url', 'about:blank', 'data:text/plain,hello', 'file:///home/person/a.html']) expect(siteOf(url), url).toBeNull()
  })
})

describe('sameSite', () => {
  it('holds across subdomains, schemes and ports', () => {
    expect(sameSite('https://www.shop.example/', 'http://cdn.shop.example:8080/x')).toBe(true)
  })

  it('does not hold across registrable domains', () => {
    expect(sameSite('https://shop.example/', 'https://other.example/')).toBe(false)
    expect(sameSite('https://shop.example/', 'https://shop.example.evil.test/')).toBe(false)
    expect(sameSite('https://shop.example/', 'https://notshop.example/')).toBe(false)
  })

  it('compares an IP address or localhost by its host', () => {
    expect(sameSite('http://127.0.0.1:1/', 'http://127.0.0.1:2/')).toBe(true)
    expect(sameSite('http://127.0.0.1/', 'http://127.0.0.2/')).toBe(false)
    expect(sameSite('http://localhost:1/', 'http://localhost:2/')).toBe(true)
    expect(sameSite('http://a.localhost/', 'http://b.localhost/')).toBe(false)
  })

  it('is false when either address has no host', () => {
    expect(sameSite('about:blank', 'about:blank')).toBe(false)
    expect(sameSite('https://shop.example/', 'nonsense')).toBe(false)
  })
})
