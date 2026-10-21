import { describe, expect, it } from 'vitest'
import { FLAVOUR_ID, MAX_ORIVON_LINK, openableOrivonLink, orivonLinkAddresses, parseOrivonLink } from '../orivon-link.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const KEY = 'k51qzi5uqu5dm0v7zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'

describe('parseOrivonLink: the forms that open something', () => {
  it('reads a .eth name, with and without a path, query and fragment', () => {
    expect(parseOrivonLink('orivon:open?u=freetube.orivonstack.eth')).toEqual({ target: 'freetube.orivonstack.eth' })
    expect(parseOrivonLink('orivon:open?u=vitalik.eth/blog/post.html')).toEqual({ target: 'vitalik.eth/blog/post.html' })
    expect(parseOrivonLink('orivon:open?u=vitalik.eth/a?b=c%23d')).toEqual({ target: 'vitalik.eth/a?b=c#d' })
  })

  it('reads an ipfs:// or ipns:// address', () => {
    expect(parseOrivonLink(`orivon:open?u=ipfs://${CID}`)).toEqual({ target: `ipfs://${CID}` })
    expect(parseOrivonLink(`orivon:open?u=ipfs://${CID}/docs/index.html`)).toEqual({ target: `ipfs://${CID}/docs/index.html` })
    expect(parseOrivonLink(`orivon:open?u=ipns://${KEY}/x`)).toEqual({ target: `ipns://${KEY}/x` })
    expect(parseOrivonLink('orivon:open?u=ipns://docs.ipfs.tech')).toEqual({ target: 'ipns://docs.ipfs.tech' })
    expect(parseOrivonLink('orivon:open?u=ipfs://freetube.orivonstack.eth')).toEqual({ target: 'ipfs://freetube.orivonstack.eth' })
  })

  it('reads the same target percent-encoded or not', () => {
    const plain = parseOrivonLink(`orivon:open?u=ipfs://${CID}/a/b`)
    expect(parseOrivonLink(`orivon:open?u=${encodeURIComponent(`ipfs://${CID}/a/b`)}`)).toEqual(plain)
    expect(parseOrivonLink(`orivon:open?u=ipfs%3A%2F%2F${CID}%2Fa%2Fb`)).toEqual(plain)
  })

  it('reads orivon://open too, with or without the slash a browser may add', () => {
    expect(parseOrivonLink('orivon://open?u=vitalik.eth')).toEqual({ target: 'vitalik.eth' })
    expect(parseOrivonLink('orivon://open/?u=vitalik.eth')).toEqual({ target: 'vitalik.eth' })
  })

  it('reads the scheme in any case, and lowercases the scheme and the name of the target', () => {
    expect(parseOrivonLink('ORIVON:open?u=vitalik.eth')).toEqual({ target: 'vitalik.eth' })
    expect(parseOrivonLink('Orivon://open?u=Vitalik.ETH/Path')).toEqual({ target: 'vitalik.eth/Path' })
    expect(parseOrivonLink(`orivon:open?u=IPFS://${CID}`)).toEqual({ target: `ipfs://${CID}` })
  })

  it('takes the parameters in either order and ignores one it does not know', () => {
    expect(parseOrivonLink('orivon:open?flavour=freetube&u=vitalik.eth')).toEqual({ target: 'vitalik.eth', flavour: 'freetube' })
    expect(parseOrivonLink('orivon:open?u=vitalik.eth&utm=1')).toEqual({ target: 'vitalik.eth' })
  })
})

describe('parseOrivonLink: flavour', () => {
  it('keeps an id of two to twenty-four lowercase letters and digits', () => {
    expect(parseOrivonLink('orivon:open?u=vitalik.eth&flavour=freetube')).toEqual({ target: 'vitalik.eth', flavour: 'freetube' })
    expect(parseOrivonLink('orivon:open?u=vitalik.eth&flavour=ab')).toEqual({ target: 'vitalik.eth', flavour: 'ab' })
    expect(parseOrivonLink('orivon:open?u=vitalik.eth&flavour=a1b2c3d4e5f6a1b2c3d4e5f6')).toEqual({ target: 'vitalik.eth', flavour: 'a1b2c3d4e5f6a1b2c3d4e5f6' })
  })

  it('opens the target without it when the id has the wrong shape, however it is written', () => {
    for (const bad of ['', 'a', 'FreeTube', 'free-tube', 'free.tube', 'free_tube', 'a1b2c3d4e5f6a1b2c3d4e5f67', 'https://evil.example', '%2e%2e', 'free%20tube', 'free%00', '%E2%80%AEab']) {
      expect(parseOrivonLink(`orivon:open?u=vitalik.eth&flavour=${bad}`), bad).toEqual({ target: 'vitalik.eth' })
    }
  })

  it('opens the target without it when it is given twice', () => {
    expect(parseOrivonLink('orivon:open?u=vitalik.eth&flavour=freetube&flavour=element')).toEqual({ target: 'vitalik.eth' })
  })

  it('has one shape, shared with whoever applies it', () => {
    expect(FLAVOUR_ID.test('freetube')).toBe(true)
    expect(FLAVOUR_ID.test('Free')).toBe(false)
  })
})

describe('parseOrivonLink: what is refused', () => {
  const refused = (text: string): void => { expect(parseOrivonLink(text), text).toBeUndefined() }

  it('refuses every target that is not a .eth name, an ipfs:// address or an ipns:// address', () => {
    for (const target of [
      'https://example.com', 'http://example.com', 'HTTPS://example.com/', 'file:///etc/passwd', 'file://host/share', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
      'data:text/html,hi', 'blob:https://a.example/x', 'orivon://settings', 'orivon:open?u=vitalik.eth', 'orivon://open?u=vitalik.eth', 'mailto:a@b.example',
      'ftp://example.com/', 'chrome://settings', 'about:blank', 'bzz://name.eth', 'magnet:?xt=urn:btih:abc', 'example.com', 'localhost', 'example.org/x.eth',
      '127.0.0.1', '//vitalik.eth', '/vitalik.eth', 'vitalik.eth:8080', 'user@vitalik.eth', 'user:pw@vitalik.eth', 'ipfs:bafy', 'ipfs:/bafy', 'ipfs:///bafy', 'ipfs://', 'ipfs:// /x'
    ]) refused(`orivon:open?u=${encodeURIComponent(target)}`)
  })

  it('refuses the same targets written unencoded', () => {
    for (const target of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'orivon://settings', 'mailto:a@b.example']) refused(`orivon:open?u=${target}`)
  })

  it('refuses another orivon: link inside u=, whatever the encoding', () => {
    refused('orivon:open?u=orivon:open?u=vitalik.eth')
    refused('orivon:open?u=orivon%3Aopen%3Fu%3Dvitalik.eth')
    refused('orivon:open?u=orivon%253Aopen')
    refused('orivon:open?u=ORIVON://settings')
    refused('orivon:open?u=orivon-shell://x')
  })

  it('refuses a .eth name that is not one host', () => {
    for (const target of ['eth', '.eth', 'a..eth', '-.eth', 'a b.eth', 'a_b.eth', 'vitalik.eth.example.com', 'vitalik.eth.', 'vitalik.etherium', 'é.eth', 'vitalik.eth\\x', 'vitalik.eth@evil.example']) {
      refused(`orivon:open?u=${encodeURIComponent(target)}`)
    }
  })

  it('refuses a name in ipfs:// or ipns:// that is not one name', () => {
    for (const target of ['ipfs://a b', 'ipfs://ünï', 'ipfs://a@b', 'ipfs://a:80/x', `ipfs://${'a'.repeat(254)}`, 'ipfs://[::1]/x', 'ipfs://a\\b']) {
      refused(`orivon:open?u=${encodeURIComponent(target)}`)
    }
  })

  it('refuses a missing, empty or repeated u=', () => {
    refused('orivon:open')
    refused('orivon:open?')
    refused('orivon:open?flavour=freetube')
    refused('orivon:open?u=')
    refused('orivon:open?u')
    refused('orivon:open?U=vitalik.eth')
    refused('orivon:open?u=vitalik.eth&u=other.eth')
    refused('orivon:open?u=vitalik.eth&u=https://evil.example')
    refused('orivon:open?u=https://evil.example&u=vitalik.eth')
  })

  it('refuses an action other than open, and a form that is not the documented one', () => {
    for (const text of [
      'orivon:settings', 'orivon://settings', 'orivon:open/?u=vitalik.eth', 'orivon:Open?u=vitalik.eth', 'orivon:opener?u=vitalik.eth', 'orivon:?u=vitalik.eth',
      'orivon:///open?u=vitalik.eth', 'orivon:////open?u=vitalik.eth', 'orivon://open/x?u=vitalik.eth', 'orivon://host/open?u=vitalik.eth', 'orivon:open#u=vitalik.eth',
      'orivon:open?u=vitalik.eth#frag', 'orivon:open?u=vitalik.eth#', 'xorivon:open?u=vitalik.eth', 'orivon.open?u=vitalik.eth', ' orivon:open?u=vitalik.eth', 'orivon:open?u=vitalik.eth ',
      'https://example.com', 'vitalik.eth', '', 'orivon', 'orivon:'
    ]) refused(text)
  })

  it('refuses `..` and `.` path tricks, written plainly or encoded, once or twice', () => {
    for (const path of ['/..', '/../x', '/a/../b', '/a/..', '/.', '/a/./b', '/%2e%2e/x', '/%2E%2E/x', '/.%2e/x', '/%2e./x', '/a/%2e/b', '/..%2f..%2fx']) {
      refused(`orivon:open?u=${encodeURIComponent(`vitalik.eth${path}`)}`)
      refused(`orivon:open?u=${encodeURIComponent(`ipfs://${CID}${path}`)}`)
    }
    refused('orivon:open?u=vitalik.eth/%252e%252e/x')
    refused(`orivon:open?u=ipfs://${CID}/..`)
    refused(`orivon:open?u=ipfs://${CID}/%2e%2e/x`)
    refused('orivon:open?u=vitalik.eth/a%2f..%2fb')
  })

  it('keeps a path segment that only contains dots', () => {
    expect(parseOrivonLink('orivon:open?u=vitalik.eth/a..b/.c/d.')).toEqual({ target: 'vitalik.eth/a..b/.c/d.' })
    expect(parseOrivonLink('orivon:open?u=vitalik.eth/...')).toEqual({ target: 'vitalik.eth/...' })
  })

  it('refuses whitespace and control characters, raw or encoded', () => {
    for (const bad of [' ', '\t', '\n', '\r', '\u0000', '\u0007', '\u007f', '\u0085', ' ', ' ', ' ', '　', '​', '﻿']) {
      refused(`orivon:open?u=vitalik.eth/a${bad}b`)
      refused(`orivon:open?u=vitalik.eth/a${encodeURIComponent(bad)}b`)
      refused(`orivon:open?u=vitalik.eth${encodeURIComponent(bad)}`)
      refused(`orivon:open?u=${encodeURIComponent(bad)}vitalik.eth`)
      refused(`orivon:open?u=vitalik.eth&x=1${bad}`)
      refused(`${bad}orivon:open?u=vitalik.eth`)
    }
    refused('orivon:open?u=vitalik.eth/a%00b')
    refused('orivon:open?u=vitalik.eth/a%0d%0ab')
    refused('orivon:open?u=vitalik.eth/a%20b')
  })

  it('refuses a bidirectional or invisible formatting character, raw or encoded', () => {
    for (const bad of ['‮', '‭', '‪', '‫', '‬', '⁦', '⁧', '⁨', '⁩', '‎', '‏', '‍', '‌', '⁠', '­']) {
      refused(`orivon:open?u=vitalik.eth/a${bad}b`)
      refused(`orivon:open?u=vitalik.eth/a${encodeURIComponent(bad)}b`)
      refused(`orivon:open?u=vitalik${encodeURIComponent(bad)}.eth`)
    }
  })

  it('refuses a character outside the URL alphabet, so a quoted command line cannot be broken out of', () => {
    for (const bad of ['"', '<', '>', '\\', '^', '`', '{', '}', '|', 'é', '\u{1f600}']) {
      refused(`orivon:open?u=vitalik.eth/a${bad}b`)
      refused(`orivon:open?u=vitalik.eth&x=${bad}`)
    }
    refused('orivon:open?u=vitalik.eth" --no-sandbox "')
    refused('orivon:open?u=vitalik.eth%22%20--no-sandbox')
    refused('orivon:open?u=vitalik.eth/a%5cb')
    refused('orivon:open?u=vitalik.eth/a%22b')
  })

  it('refuses a percent sign that starts no escape, and an escape that is not UTF-8', () => {
    refused('orivon:open?u=vitalik.eth/%')
    refused('orivon:open?u=vitalik.eth/%zz')
    refused('orivon:open?u=vitalik.eth/%e')
    refused('orivon:open?u=vitalik.eth/%ff')
    refused('orivon:open?u=vitalik.eth/%c0%af')
    refused('orivon:open?u=%')
  })

  it('refuses input that is too long, and accepts one at the limit', () => {
    const head = 'orivon:open?u=vitalik.eth/'
    expect(parseOrivonLink(head + 'a'.repeat(MAX_ORIVON_LINK - head.length))).toBeDefined()
    refused(head + 'a'.repeat(MAX_ORIVON_LINK - head.length + 1))
    refused(head + 'a'.repeat(100_000))
    refused('orivon:open?u=vitalik.eth' + '&x=1'.repeat(1000))
    refused('orivon:open?u=' + '%41'.repeat(3000))
  })

  it('refuses a value that is not text', () => {
    for (const value of [undefined, null, 5, {}, [], ['orivon:open?u=vitalik.eth'], true]) {
      expect(parseOrivonLink(value as unknown as string)).toBeUndefined()
    }
  })

  it('never throws, whatever it is given', () => {
    const pieces = ['orivon:', 'open', '?', 'u=', '&', 'flavour=', '%', '%e0%a4', 'ipfs://', '..', '/', '‮', '\u0000', 'vitalik.eth', ':', '#', '=', '\ud800']
    let seed = 12345
    const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    for (let n = 0; n < 3000; n++) {
      let text = ''
      for (let i = 0; i < 1 + next() % 8; i++) text += pieces[next() % pieces.length]
      expect(() => parseOrivonLink(text), text).not.toThrow()
    }
  })
})

describe('openableOrivonLink: the address that opens', () => {
  it('serves a .eth name as its own origin', () => {
    expect(openableOrivonLink('orivon:open?u=vitalik.eth')).toEqual({ url: 'https://vitalik.eth/' })
    expect(openableOrivonLink('orivon:open?u=Vitalik.eth/a?b=c')).toEqual({ url: 'https://vitalik.eth/a?b=c' })
  })

  it('serves an ipfs:// or ipns:// address as the address bar would', () => {
    expect(openableOrivonLink(`orivon:open?u=ipfs://${CID}/x`)).toEqual({ url: `https://ipfs.orivon/${CID}/x` })
    expect(openableOrivonLink('orivon:open?u=ipns://docs.ipfs.tech')).toEqual({ url: 'https://ipns.orivon/docs.ipfs.tech/' })
    expect(openableOrivonLink('orivon:open?u=ipfs://freetube.orivonstack.eth')).toEqual({ url: 'https://freetube.orivonstack.eth/' })
  })

  it('carries a valid flavour along and nothing else', () => {
    expect(openableOrivonLink('orivon:open?u=vitalik.eth&flavour=freetube')).toEqual({ url: 'https://vitalik.eth/', flavour: 'freetube' })
  })

  it('is undefined for a link that is refused', () => {
    expect(openableOrivonLink('orivon:open?u=https://example.com')).toBeUndefined()
    expect(openableOrivonLink('https://example.com')).toBeUndefined()
  })
})

describe('orivonLinkAddresses', () => {
  it('lists the address of each link among the arguments, in order, and skips every other argument', () => {
    expect(orivonLinkAddresses(['orivon:open?u=a.eth', 'https://example.com', 'orivon:open?u=file:///etc/passwd', 'orivon://open?u=b.eth', '--x'])).toEqual(['https://a.eth/', 'https://b.eth/'])
  })

  it('stops at the limit', () => {
    expect(orivonLinkAddresses(['orivon:open?u=a.eth', 'orivon:open?u=b.eth', 'orivon:open?u=c.eth'], 2)).toEqual(['https://a.eth/', 'https://b.eth/'])
  })
})
