import { describe, expect, it } from 'vitest'
import { ProtocolAddresses, labelFor } from '../address.js'
import { BUILTIN_PROTOCOLS } from '../builtin.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const addresses = new ProtocolAddresses(BUILTIN_PROTOCOLS)

describe('labelFor', () => {
  it('inlines a DNS name into one label the way IPFS subdomain gateways do, and leaves a CID alone', () => {
    expect(labelFor('en.wikipedia-on-ipfs.org')).toBe('en-wikipedia--on--ipfs-org')
    expect(labelFor(CID)).toBe(CID)
  })

  it('is undefined for a name that cannot be one host label', () => {
    expect(labelFor('QmUpperCase')).toBeUndefined()
    expect(labelFor('a'.repeat(64))).toBeUndefined()
    expect(labelFor('')).toBeUndefined()
  })

  it('never gives two names one label, and never a label Chromium would parse as punycode', () => {
    expect(labelFor('a-.b')).toBe('a---b')
    expect(labelFor('a.-b')).toBeUndefined()
    expect(labelFor('a..b')).toBeUndefined()
    expect(labelFor('a-b')).toBe('a--b')
    expect(labelFor('xn--mnchen-3ya.de')).toBeUndefined()
    expect(labelFor('xn-.a')).toBeUndefined()
  })
})

describe('ProtocolAddresses', () => {
  it('routes each top-level domain and the one address suffix to the verifier, and nothing else', () => {
    expect(addresses.routedSuffixes()).toEqual(['eth', 'orivon'])
    for (const host of ['vitalik.eth', 'Vitalik.ETH', `${CID}.ipfs.orivon`, 'ipfs.orivon', 'unknown.scheme.orivon']) expect(addresses.routesToVerifier(host)).toBe(true)
    // `MAP *.eth` does not match a trailing dot, so neither may this: the loader would skip a public-address check for a host DNS resolves.
    for (const host of ['eth', 'orivon', 'example.com', 'eth.example.com', 'orivon.example', 'a..eth', 'vitalik.eth.', `${CID}.ipfs.orivon.`]) expect(addresses.routesToVerifier(host)).toBe(false)
  })

  it('reads a host as its namespace and name', () => {
    expect(addresses.servedName('Vitalik.ETH')).toEqual({ namespace: '.eth', name: 'vitalik.eth' })
    expect(addresses.servedName(`${CID}.ipfs.orivon`)).toEqual({ namespace: 'ipfs:', name: CID })
    expect(addresses.servedName('en-wikipedia--on--ipfs-org.ipns.orivon')).toEqual({ namespace: 'ipns:', name: 'en.wikipedia-on-ipfs.org' })
    for (const host of ['ipfs.orivon', 'a.b.ipfs.orivon', `${CID}.nope.orivon`, 'example.com', 'eth', 'vitalik.eth.', `${CID}.ipfs.orivon.`]) expect(addresses.servedName(host)).toBeUndefined()
  })

  it('names the scheme endpoint, and only for a registered scheme', () => {
    expect(addresses.schemeEndpoint('ipfs.orivon')).toBe('ipfs')
    expect(addresses.schemeEndpoint('IPNS.orivon')).toBe('ipns')
    expect(addresses.schemeEndpoint('ipns.orivon.')).toBeUndefined()
    expect(addresses.schemeEndpoint('nope.orivon')).toBeUndefined()
    expect(addresses.schemeEndpoint(`${CID}.ipfs.orivon`)).toBeUndefined()
  })

  it('gives the origin of a canonical name, or undefined when it cannot be a host', () => {
    expect(addresses.originFor('ipfs', CID)).toBe(`https://${CID}.ipfs.orivon`)
    expect(addresses.originFor('ipns', 'docs.ipfs.tech')).toBe('https://docs-ipfs-tech.ipns.orivon')
    expect(addresses.originFor('nope', CID)).toBeUndefined()
    expect(addresses.originFor('ipfs', 'Qm')).toBeUndefined()
  })

  it('turns a typed or linked address into its scheme endpoint, keeping the name as written', () => {
    expect(addresses.servedUrl(`ipfs://${CID}`)).toBe(`https://ipfs.orivon/${CID}/`)
    expect(addresses.servedUrl('IPNS://Docs.IPFS.tech/a/b?c=d#e')).toBe('https://ipns.orivon/Docs.IPFS.tech/a/b?c=d#e')
    expect(addresses.servedUrl('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG?x')).toBe('https://ipfs.orivon/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/?x')
  })

  it.each(['https://example.com', 'magnet:?xt=1', 'ipfs://', 'ipfs:///path', 'ipfs://a b', 'ipfs://a%2fb', 'ipfs://user@cid', 'javascript://x', `ipfs://${'a'.repeat(254)}`])('does not serve %s', (input) => {
    expect(addresses.servedUrl(input)).toBeUndefined()
  })

  it('shows a served URL as its address, and every other URL as it is', () => {
    expect(addresses.displayUrl(`https://${CID}.ipfs.orivon/docs/a.html?x=1#top`)).toBe(`ipfs://${CID}/docs/a.html?x=1#top`)
    expect(addresses.displayUrl('https://en-wikipedia--on--ipfs-org.ipns.orivon/')).toBe('ipns://en.wikipedia-on-ipfs.org/')
    expect(addresses.displayUrl('https://ipfs.orivon/QmAbc/x')).toBe('ipfs://QmAbc/x')
    for (const url of ['https://vitalik.eth/', 'https://example.com/', `http://${CID}.ipfs.orivon/`, `https://${CID}.ipfs.orivon:8443/`, 'https://ipfs.orivon/', 'not a url']) {
      expect(addresses.displayUrl(url)).toBe(url)
    }
  })

  it('strips userinfo from what it shows, so a lookalike host before the @ cannot pass as the real one', () => {
    expect(addresses.displayUrl('https://www.bank.example@evil.example/login')).toBe('https://evil.example/login')
    expect(addresses.displayUrl('https://user:pass@example.com/path?q=1#f')).toBe('https://example.com/path?q=1#f')
    // A served host behind userinfo still shortens once the userinfo is gone.
    expect(addresses.displayUrl(`https://x@${CID}.ipfs.orivon/a`)).toBe(`ipfs://${CID}/a`)
  })

  it('shows a served origin as its address', () => {
    expect(addresses.displayOrigin(`https://${CID}.ipfs.orivon`)).toBe(`ipfs://${CID}`)
    expect(addresses.displayOrigin('https://vitalik.eth')).toBe('https://vitalik.eth')
  })

  it('round-trips: the address a served URL shows loads that same served URL once canonical', () => {
    const shown = addresses.displayUrl(`https://${CID}.ipfs.orivon/a?b`)
    expect(addresses.servedUrl(shown)).toBe(`https://ipfs.orivon/${CID}/a?b`)
  })
})
