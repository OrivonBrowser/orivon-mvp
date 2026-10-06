import { describe, expect, it } from 'vitest'
import { classOfKey, isPublicHostName, reportedKey, siteKeyFor } from '../site-key.js'

describe('siteKeyFor', () => {
  it('names a Web3 site by its ENS or DNS name', () => {
    expect(siteKeyFor({ url: 'https://Vitalik.eth/blog', siteClass: 'web3', judged: false })).toBe('web3:vitalik.eth')
    expect(siteKeyFor({ url: 'ipns://docs.example.org/x', siteClass: 'web3', judged: false })).toBe('web3:docs.example.org')
  })

  it('names a Web2.5 site by its DNS name, without the port or the path', () => {
    expect(siteKeyFor({ url: 'https://app.example.org:8443/a?b=c#d', siteClass: 'web25', judged: false })).toBe('web25:app.example.org')
  })

  it('never names a Web2 site, however the address looks', () => {
    expect(siteKeyFor({ url: 'https://news.example.com/story', siteClass: 'web2', judged: true })).toBe('web2')
    expect(siteKeyFor({ url: 'https://news.example.com/', siteClass: null, judged: false })).toBe('web2')
  })

  it('counts a CID, an IPNS key or a local host under its class alone unless a provider judged it', () => {
    const cid = 'bafybeibnroh2zbqvqgasvvnphmlzdpsvthyzyp3zlcgxqxsgk6kbtmeqmy'
    expect(siteKeyFor({ url: `ipfs://${cid}/`, siteClass: 'web3', judged: false })).toBe('web3:')
    expect(siteKeyFor({ url: `ipfs://${cid}/`, siteClass: 'web3', judged: true })).toBe(`web3:${cid}`)
    expect(siteKeyFor({ url: 'http://localhost:3000/', siteClass: 'web25', judged: false })).toBe('web25:')
    expect(siteKeyFor({ url: 'http://192.168.1.4/', siteClass: 'web25', judged: false })).toBe('web25:')
    expect(siteKeyFor({ url: 'http://printer.local/', siteClass: 'web25', judged: false })).toBe('web25:')
  })

  it('counts the browser own pages and local files as internal', () => {
    for (const url of ['', 'about:blank', 'orivon://settings/', 'orivon-shell://renderer/newtab.html', 'file:///home/a/b.html', 'not a url']) {
      expect(siteKeyFor({ url, siteClass: 'web3', judged: true })).toBe('internal')
    }
  })
})

describe('isPublicHostName', () => {
  it('accepts dotted names and refuses single labels, addresses and local suffixes', () => {
    expect(isPublicHostName('example.com')).toBe(true)
    expect(isPublicHostName('a.b.example.co.uk')).toBe(true)
    for (const host of ['localhost', 'a.localhost', '127.0.0.1', '10.0.0.1', 'nas.lan', 'x.home.arpa', 'a_b.example.com', '-a.example.com', '']) {
      expect(isPublicHostName(host)).toBe(false)
    }
  })
})

describe('classOfKey and reportedKey', () => {
  it('maps a key to its class and an empty name to (unlisted)', () => {
    expect(classOfKey('web3:a.eth')).toBe('web3')
    expect(classOfKey('web25:')).toBe('web25')
    expect(classOfKey('web2')).toBe('web2')
    expect(classOfKey('internal')).toBeUndefined()
    expect(reportedKey('web3:')).toBe('web3:(unlisted)')
    expect(reportedKey('web25:b.org')).toBe('web25:b.org')
  })
})
