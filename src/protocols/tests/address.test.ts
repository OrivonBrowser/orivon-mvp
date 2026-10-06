import { describe, expect, it } from 'vitest'
import { ProtocolAddresses, labelFor } from '../address.js'
import { BUILTIN_PROTOCOLS } from '../builtin.js'
import { describeProtocol } from '../protocol.js'

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

  it('sends an address scheme written over a top-level-domain name straight to that name\'s own origin', () => {
    expect(addresses.servedUrl('ipfs://vitalik.eth/x')).toBe('https://vitalik.eth/x')
    expect(addresses.servedUrl('ipns://Vitalik.ETH/x')).toBe('https://vitalik.eth/x')
    expect(addresses.servedUrl('ipfs://vitalik.eth')).toBe('https://vitalik.eth/')
  })

  it.each(['https://example.com', 'magnet:?xt=1', 'ipfs://', 'ipfs:///path', 'ipfs://a b', 'ipfs://a%2fb', 'ipfs://user@cid', 'javascript://x', `ipfs://${'a'.repeat(254)}`])('does not serve %s', (input) => {
    expect(addresses.servedUrl(input)).toBeUndefined()
  })

  it('shows a served URL as its address, and every other URL as it is', () => {
    expect(addresses.displayUrl(`https://${CID}.ipfs.orivon/docs/a.html?x=1#top`)).toBe(`ipfs://${CID}/docs/a.html?x=1#top`)
    expect(addresses.displayUrl('https://en-wikipedia--on--ipfs-org.ipns.orivon/')).toBe('ipns://en.wikipedia-on-ipfs.org/')
    expect(addresses.displayUrl('https://ipfs.orivon/QmAbc/x')).toBe('ipfs://QmAbc/x')
    for (const url of ['https://example.com/', `http://${CID}.ipfs.orivon/`, `https://${CID}.ipfs.orivon:8443/`, 'https://ipfs.orivon/', 'not a url']) {
      expect(addresses.displayUrl(url)).toBe(url)
    }
  })

  it('shows a .eth name under its ipfs display scheme, keeping path, query and hash', () => {
    expect(addresses.displayUrl('https://vitalik.eth/blog/?a=1#b')).toBe('ipfs://vitalik.eth/blog/?a=1#b')
    expect(addresses.displayOrigin('https://vitalik.eth')).toBe('ipfs://vitalik.eth')
  })

  it('leaves a .eth name unchanged when it is not https on its default port, or has a trailing dot', () => {
    for (const url of ['http://freetube.eth/', 'https://vitalik.eth:8443/', 'https://vitalik.eth./']) {
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
  })

  it('round-trips: the address a served URL shows loads that same served URL once canonical', () => {
    const shown = addresses.displayUrl(`https://${CID}.ipfs.orivon/a?b`)
    expect(addresses.servedUrl(shown)).toBe(`https://ipfs.orivon/${CID}/a?b`)
  })

  it('round-trips a .eth name: the address it is shown as loads its own origin back', () => {
    const shown = addresses.displayUrl('https://vitalik.eth/blog/')
    expect(addresses.servedUrl(shown)).toBe('https://vitalik.eth/blog/')
  })

  it('refuses a descriptor whose displayScheme no given protocol serves', () => {
    const ens = describeProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'], displayScheme: 'ipfs' })
    expect(() => new ProtocolAddresses([ens])).toThrow(/displayScheme ipfs/)
  })
})

describe('loadingScreenFor', () => {
  const IPFS_SCREEN = BUILTIN_PROTOCOLS.find((p) => p.id === 'ipfs')?.loadingScreen

  it('gives the screen of the protocol serving an address host', () => {
    expect(IPFS_SCREEN?.title).toBeTruthy()
    expect(addresses.loadingScreenFor(`https://${CID}.ipfs.orivon/docs/`)).toBe(IPFS_SCREEN)
    expect(addresses.loadingScreenFor('https://en-wikipedia--on--ipfs-org.ipns.orivon/')).toBe(IPFS_SCREEN)
  })

  it('gives it for the scheme endpoint, which redirects to the origin', () => {
    expect(addresses.loadingScreenFor(`https://ipfs.orivon/${CID}/`)).toBe(IPFS_SCREEN)
    expect(addresses.loadingScreenFor('https://ipns.orivon/example.com')).toBe(IPFS_SCREEN)
  })

  it('gives a top-level-domain name with no screen its display scheme protocol screen', () => {
    expect(addresses.loadingScreenFor('https://vitalik.eth/')).toBe(IPFS_SCREEN)
  })

  it('prefers a protocol own screen to its display scheme one', () => {
    const own = { title: 'Reading the chain' }
    const mine = new ProtocolAddresses([
      describeProtocol({ id: 'ipfs', schemes: ['ipfs'], topLevelDomains: [], loadingScreen: { title: 'Loading from IPFS' } }),
      describeProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'], displayScheme: 'ipfs', loadingScreen: own })
    ])
    expect(mine.loadingScreenFor('https://vitalik.eth/')).toEqual(own)
    expect(mine.loadingScreenFor(`https://${CID}.ipfs.orivon/`)?.title).toBe('Loading from IPFS')
  })

  it('is undefined when the protocol declares none and shows no other scheme', () => {
    const bare = new ProtocolAddresses([describeProtocol({ id: 'plain', schemes: ['plain'], topLevelDomains: [] })])
    expect(bare.loadingScreenFor(`https://${CID}.plain.orivon/`)).toBeUndefined()
  })

  it('is undefined for a URL that is not a served address', () => {
    for (const url of [
      'https://example.com/', `http://${CID}.ipfs.orivon/`, `https://${CID}.ipfs.orivon:8443/`, `https://${CID}.nope.orivon/`,
      'https://ipfs.orivon/', 'https://ipfs.orivon', 'ipfs://' + CID, 'not a url', '', 'https://a..eth/'
    ]) expect(addresses.loadingScreenFor(url)).toBeUndefined()
  })
})
