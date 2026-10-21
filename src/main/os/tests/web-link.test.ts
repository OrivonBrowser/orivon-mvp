import { describe, expect, it } from 'vitest'
import { canonicalCid } from '../../../protocols/ipfs/names.js'
import { webLinkDiffering, webLinkFor } from '../web-link.js'

const V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const V1 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
const KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'
const PEER = '12D3KooWRBy97UB99e3J6hiPesre1MZeuNQvfan4gBziswrRJsNK'

describe('a .eth name', () => {
  it('opens through eth.limo, whichever way it is shown', () => {
    expect(webLinkFor('ipfs://vitalik.eth')).toBe('https://vitalik.eth.limo/')
    expect(webLinkFor('ipns://vitalik.eth')).toBe('https://vitalik.eth.limo/')
    expect(webLinkFor('https://vitalik.eth')).toBe('https://vitalik.eth.limo/')
    expect(webLinkFor('http://vitalik.eth/')).toBe('https://vitalik.eth.limo/')
  })

  it('keeps the path, the query and the fragment, and the trailing slash or its absence', () => {
    expect(webLinkFor('ipfs://vitalik.eth/blog/2024/?a=1&b=two#top')).toBe('https://vitalik.eth.limo/blog/2024/?a=1&b=two#top')
    expect(webLinkFor('ipfs://vitalik.eth/blog')).toBe('https://vitalik.eth.limo/blog')
    expect(webLinkFor('ipfs://vitalik.eth/')).toBe('https://vitalik.eth.limo/')
    expect(webLinkFor('ipns://vitalik.eth?a=1')).toBe('https://vitalik.eth.limo/?a=1')
    expect(webLinkFor('ipfs://vitalik.eth#top')).toBe('https://vitalik.eth.limo/#top')
    expect(webLinkFor('https://vitalik.eth/x?y=1#z')).toBe('https://vitalik.eth.limo/x?y=1#z')
  })

  it('keeps percent-encoding as it is, and encodes what a browser would', () => {
    expect(webLinkFor('ipfs://vitalik.eth/a%20b/%E2%9C%93?q=%26x#f%2Fg')).toBe('https://vitalik.eth.limo/a%20b/%E2%9C%93?q=%26x#f%2Fg')
    expect(webLinkFor('ipfs://vitalik.eth/a b')).toBeUndefined()
  })

  it('handles names of several labels', () => {
    expect(webLinkFor('ipfs://app.sub.name.eth/x')).toBe('https://app.sub.name.eth.limo/x')
    expect(webLinkFor('https://app.sub.name.eth/x')).toBe('https://app.sub.name.eth.limo/x')
  })

  it('lowercases the name and the scheme, and leaves the path\'s case alone', () => {
    expect(webLinkFor('IPFS://Vitalik.ETH/Blog/Post')).toBe('https://vitalik.eth.limo/Blog/Post')
    expect(webLinkFor('HTTPS://VITALIK.ETH/Blog')).toBe('https://vitalik.eth.limo/Blog')
  })

  it('refuses what is not a name another browser could reach', () => {
    for (const bad of ['ipfs://eth', 'ipfs://.eth', 'ipfs://a..eth', 'ipfs://-a.eth', 'ipfs://vit alik.eth', 'ipfs://vitalik.eth.', 'ipfs://vitalik.eth:8080/', 'ipfs://user@vitalik.eth/', 'https://vitalik.eth:8443/', 'https://user@vitalik.eth/', 'ipfs://vétalik.eth/']) {
      expect(webLinkFor(bad), bad).toBeUndefined()
    }
  })

  it('does not rewrite a name that merely ends in eth', () => {
    expect(webLinkFor('https://example.com/vitalik.eth')).toBe('https://example.com/vitalik.eth')
    expect(webLinkFor('https://beth.example/')).toBe('https://beth.example/')
  })
})

describe('an IPFS content address', () => {
  it('opens through a dweb.link subdomain, the CID as it is when it is CIDv1 base32', () => {
    expect(webLinkFor(`ipfs://${V1}/docs/a.html?x=1#y`)).toBe(`https://${V1}.ipfs.dweb.link/docs/a.html?x=1#y`)
    expect(webLinkFor(`ipfs://${V1}`)).toBe(`https://${V1}.ipfs.dweb.link/`)
  })

  it('converts a CIDv0 to CIDv1 base32, since a subdomain is lowercase', () => {
    expect(webLinkFor(`ipfs://${V0}/x`)).toBe(`https://${V1}.ipfs.dweb.link/x`)
  })

  it('accepts the uppercase spelling of a base32 CID and lowers it', () => {
    expect(webLinkFor(`ipfs://${V1.toUpperCase()}/x`)).toBe(`https://${V1}.ipfs.dweb.link/x`)
  })

  it('refuses an invalid CID, a name that is not one, and a DNSLink domain', () => {
    for (const bad of ['ipfs://Qm123', 'ipfs://bafybeie5nqv6kd3', `ipfs://${V1}x`, 'ipfs://notacid', 'ipfs://docs.ipfs.tech/', 'ipfs://', 'ipfs:///x']) {
      expect(webLinkFor(bad), bad).toBeUndefined()
    }
  })

  it('refuses a CID too long for one host label', () => {
    // A sha2-512 CIDv1 in base32 is a valid CID, 110 characters long.
    expect(canonicalCid('bafybgqd3ks3gqnwb7porhusedwpbing4mlfgo75wr5p6m2sgjovn5tn5ablw7dllllb3zsaiis35kcy4yzqdirf347h47d6avipohrrw3hrts')).toBeDefined()
    expect(webLinkFor('ipfs://bafybgqd3ks3gqnwb7porhusedwpbing4mlfgo75wr5p6m2sgjovn5tn5ablw7dllllb3zsaiis35kcy4yzqdirf347h47d6avipohrrw3hrts/x')).toBeUndefined()
  })
})

describe('an IPNS key', () => {
  it('opens through an ipns.dweb.link subdomain', () => {
    expect(webLinkFor(`ipns://${KEY}/a/b?q=1#f`)).toBe(`https://${KEY}.ipns.dweb.link/a/b?q=1#f`)
  })

  it('converts a bare peer ID to the libp2p-key CIDv1 in base36', () => {
    expect(webLinkFor(`ipns://${PEER}/`)).toBe(`https://${KEY}.ipns.dweb.link/`)
  })

  it('refuses what is not a key, and a DNSLink domain', () => {
    for (const bad of ['ipns://notakey', 'ipns://example.com/', 'ipns://k51qzi5uqu5dlvj2', 'ipns://']) {
      expect(webLinkFor(bad), bad).toBeUndefined()
    }
  })
})

describe('an ordinary web address', () => {
  it('comes back unchanged', () => {
    for (const url of ['https://example.com/', 'http://example.com/a?b=1#c', 'https://sub.example.co.uk:8443/x%20y', 'http://localhost:3000/']) {
      expect(webLinkFor(url), url).toBe(url)
    }
  })
})

describe('an address with no web link', () => {
  it('is refused: Orivon pages, files, other schemes, Orivon\'s own hosts, text that is no address', () => {
    for (const none of ['orivon://settings', 'orivon://history', 'file:///home/a/b.html', 'view-source:https://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'bzz://vitalik.eth', 'swarm://abc', 'chrome-extension://abc/page.html', 'https://abc.ipfs.orivon/x', 'https://ipfs.orivon/name', 'vitalik.eth', 'example.com', '', '   ', 'ftp://example.com/']) {
      expect(webLinkFor(none), none).toBeUndefined()
    }
  })

  it('is refused when the text holds a space or a control character', () => {
    expect(webLinkFor('https://example.com/a b')).toBeUndefined()
    expect(webLinkFor('ipfs://vitalik.eth/\u0000')).toBeUndefined()
    expect(webLinkFor('ipfs://vitalik.eth/a\nb')).toBeUndefined()
  })
})

describe('webLinkDiffering', () => {
  it('is the link where it says something the address does not, and nothing for a web address', () => {
    expect(webLinkDiffering('ipfs://vitalik.eth/x')).toBe('https://vitalik.eth.limo/x')
    expect(webLinkDiffering('https://example.com/')).toBeUndefined()
    expect(webLinkDiffering('https://example.com/ ')).toBeUndefined()
    expect(webLinkDiffering('orivon://settings')).toBeUndefined()
  })
})
