import { describe, expect, it } from 'vitest'
import { addressClip, addressesClip } from '../address-clipboard.js'

const V1 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
const KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'

describe('addressClip', () => {
  it('carries a .eth address as its own text and a link through eth.limo', () => {
    expect(addressClip('ipfs://explore.orivonstack.eth')).toEqual({
      text: 'ipfs://explore.orivonstack.eth',
      html: '<a href="https://explore.orivonstack.eth.limo/">ipfs://explore.orivonstack.eth</a>'
    })
  })

  it('keeps the path, the query and the fragment in the link and the text', () => {
    expect(addressClip('ipfs://vitalik.eth/blog/post?a=1#top')).toEqual({
      text: 'ipfs://vitalik.eth/blog/post?a=1#top',
      html: '<a href="https://vitalik.eth.limo/blog/post?a=1#top">ipfs://vitalik.eth/blog/post?a=1#top</a>'
    })
  })

  it('links an IPFS content address and an IPNS key through dweb.link', () => {
    expect(addressClip(`ipfs://${V1}/a`)).toEqual({ text: `ipfs://${V1}/a`, html: `<a href="https://${V1}.ipfs.dweb.link/a">ipfs://${V1}/a</a>` })
    expect(addressClip(`ipns://${KEY}`)).toEqual({ text: `ipns://${KEY}`, html: `<a href="https://${KEY}.ipns.dweb.link/">ipns://${KEY}</a>` })
  })

  it('writes plain text only for an address whose own link is the address', () => {
    expect(addressClip('https://example.com/a?b=1')).toEqual({ text: 'https://example.com/a?b=1' })
    expect(addressClip('https://explore.orivonstack.eth.limo/')).toEqual({ text: 'https://explore.orivonstack.eth.limo/' })
    expect('html' in addressClip('https://example.com/')).toBe(false)
  })

  it('writes plain text only for an address with no web link', () => {
    for (const address of ['orivon://settings', 'bzz://abc123/x', 'file:///tmp/a.txt', 'ipfs://example.com/x', 'ipfs://vitalik.eth/a b', 'plain text', '']) {
      expect(addressClip(address)).toEqual({ text: address })
    }
  })

  it('escapes the link and the text, so no address can close the tag or add an attribute', () => {
    const clip = addressClip('ipfs://vitalik.eth/p<q>?a=1&b="2"#it\'s')
    expect(clip.text).toBe('ipfs://vitalik.eth/p<q>?a=1&b="2"#it\'s')
    expect(clip.html).toBe('<a href="https://vitalik.eth.limo/p%3Cq%3E?a=1&amp;b=%222%22#it&#39;s">ipfs://vitalik.eth/p&lt;q&gt;?a=1&amp;b=&quot;2&quot;#it&#39;s</a>')
    expect(clip.html?.match(/</g)).toHaveLength(2)
  })

  it('writes an address with no link as it is, whatever characters it holds', () => {
    expect(addressClip('a<b>&"')).toEqual({ text: 'a<b>&"' })
  })
})

describe('addressesClip', () => {
  it('is one address as addressClip has it', () => {
    expect(addressesClip(['ipfs://vitalik.eth'])).toEqual(addressClip('ipfs://vitalik.eth'))
    expect(addressesClip([])).toEqual({ text: '' })
  })

  it('writes plain lines when no address has a link', () => {
    expect(addressesClip(['https://a.example/', 'orivon://settings'])).toEqual({ text: 'https://a.example/\norivon://settings' })
  })

  it('links every address that has a web form once one of them has a link, and escapes the rest, one per line', () => {
    expect(addressesClip(['https://a.example/?x=1&y=2', 'ipfs://vitalik.eth/b', 'orivon://settings?a=<b>'])).toEqual({
      text: 'https://a.example/?x=1&y=2\nipfs://vitalik.eth/b\norivon://settings?a=<b>',
      html: '<a href="https://a.example/?x=1&amp;y=2">https://a.example/?x=1&amp;y=2</a><br><a href="https://vitalik.eth.limo/b">ipfs://vitalik.eth/b</a><br>orivon://settings?a=&lt;b&gt;'
    })
  })

  it('builds no HTML at all when no address has a link of its own to give', () => {
    const clip = addressesClip(['https://a.example/', 'https://b.example/x?y=1&z=2', 'orivon://settings'])
    expect(clip).toEqual({ text: 'https://a.example/\nhttps://b.example/x?y=1&z=2\norivon://settings' })
    expect('html' in clip).toBe(false)
  })
})
