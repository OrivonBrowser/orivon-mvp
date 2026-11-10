import { describe, expect, it } from 'vitest'
import { mirrorSiteOf } from '../mirror-site.js'

describe('the site an address belongs to, for the cookie mirror', () => {
  it('is the registrable domain, so the subdomains of a site are one site and two registrable domains are two', () => {
    expect(mirrorSiteOf('https://www.shop.example.com/a?b#c')).toBe('example.com')
    expect(mirrorSiteOf('https://cdn.shop.example.com:8443/')).toBe('example.com')
    expect(mirrorSiteOf('https://other.example.org/')).toBe('example.org')
    expect(mirrorSiteOf('https://bank.socks.test/')).toBe('socks.test')
  })

  it('counts the private section of the public suffix list: a service that hands out domains to its customers is not one site', () => {
    expect(mirrorSiteOf('https://alice.github.io/')).toBe('alice.github.io')
    expect(mirrorSiteOf('https://bob.github.io/')).toBe('bob.github.io')
    expect(mirrorSiteOf('https://d111111abcdef8.cloudfront.net/x')).toBe('d111111abcdef8.cloudfront.net')
    expect(mirrorSiteOf('https://d222222abcdef8.cloudfront.net/x')).not.toBe(mirrorSiteOf('https://d111111abcdef8.cloudfront.net/x'))
    expect(mirrorSiteOf('https://bucket-a.s3.amazonaws.com/')).not.toBe(mirrorSiteOf('https://bucket-b.s3.amazonaws.com/'))
    expect(mirrorSiteOf('https://vitalik.eth.limo/')).toBe('vitalik.eth.limo')
    expect(mirrorSiteOf('https://other.eth.limo/')).toBe('other.eth.limo')
  })

  it('is the whole host for an address Orivon serves: every content address, Swarm hash and .eth name is a party of its own', () => {
    expect(mirrorSiteOf('https://bafyone.ipfs.orivon/')).toBe('bafyone.ipfs.orivon')
    expect(mirrorSiteOf('https://bafytwo.ipfs.orivon/index.html')).toBe('bafytwo.ipfs.orivon')
    expect(mirrorSiteOf('https://k51qzi5uqu5.ipns.orivon/')).toBe('k51qzi5uqu5.ipns.orivon')
    expect(mirrorSiteOf('https://feedhash.bzz.orivon/')).toBe('feedhash.bzz.orivon')
    expect(mirrorSiteOf('https://vitalik.eth/')).toBe('vitalik.eth')
    expect(mirrorSiteOf('https://www.vitalik.eth/')).toBe('www.vitalik.eth')
    expect(mirrorSiteOf('https://alice.base.eth/')).toBe('alice.base.eth')
    expect(mirrorSiteOf('https://bob.base.eth/')).toBe('bob.base.eth')
    expect(mirrorSiteOf('https://base.eth/')).toBe('base.eth')
  })

  it('is the host itself when there is no registrable domain, and nothing for what is not an address', () => {
    expect(mirrorSiteOf('http://127.0.0.1:8080/')).toBe('127.0.0.1')
    expect(mirrorSiteOf('http://[::1]:8080/')).toBe('::1')
    expect(mirrorSiteOf('http://localhost:3000/')).toBe('localhost')
    expect(mirrorSiteOf('not an address')).toBeUndefined()
    expect(mirrorSiteOf('')).toBeUndefined()
  })
})
