import { describe, expect, it } from 'vitest'
import { mergeBeforeRequest, mergeRequestHeaders, mergeResponseHeaders, redirectAllowed, type Reply } from '../merge.js'

const ME = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const reply = (response: unknown, installedAt = 1, extensionId = ME): Reply => ({ extensionId, installedAt, response })

describe('mergeBeforeRequest', () => {
  it('says nothing when nobody has an opinion', () => {
    expect(mergeBeforeRequest([])).toBeUndefined()
    expect(mergeBeforeRequest([reply(undefined), reply({}), reply(null), reply('x')])).toBeUndefined()
  })

  it('cancels when any listener cancels, whatever the others redirect to', () => {
    expect(mergeBeforeRequest([reply({ redirectUrl: 'https://a.example/' }, 9), reply({ cancel: true }, 1)])).toEqual({ cancel: true })
  })

  it('only a literal true cancels', () => {
    expect(mergeBeforeRequest([reply({ cancel: 'true' }), reply({ cancel: 1 })])).toBeUndefined()
  })

  it('takes the redirect of the most recently installed extension', () => {
    expect(mergeBeforeRequest([
      reply({ redirectUrl: 'https://new.example/' }, 20, OTHER),
      reply({ redirectUrl: 'https://old.example/' }, 10, ME)
    ])).toEqual({ redirectUrl: 'https://new.example/' })
  })

  it('drops a redirect it may not follow and falls back to an older allowed one', () => {
    expect(mergeBeforeRequest([
      reply({ redirectUrl: 'https://old.example/' }, 10),
      reply({ redirectUrl: 'javascript:alert(1)' }, 20, OTHER)
    ])).toEqual({ redirectUrl: 'https://old.example/' })
  })

  it('ignores a redirect that is not a string', () => {
    expect(mergeBeforeRequest([reply({ redirectUrl: 5 }), reply({ redirectUrl: { href: 'https://a.example/' } })])).toBeUndefined()
  })
})

describe('redirectAllowed', () => {
  it('allows the web, data, a blank page and the extension\'s own pages', () => {
    for (const url of ['http://a.example/', 'https://a.example/x?y=1', 'ws://a.example/', 'wss://a.example/', 'data:text/javascript,0', 'about:blank', `chrome-extension://${ME}/web_accessible_resources/x.js?secret=1`]) {
      expect(redirectAllowed(ME, url)).toBe(true)
    }
  })

  it('refuses another extension, javascript, file, blob, orivon, other about pages and junk', () => {
    for (const url of [`chrome-extension://${OTHER}/x.js`, 'javascript:alert(1)', 'file:///etc/passwd', 'blob:https://a.example/1', 'orivon://settings', 'about:srcdoc', 'chrome://gpu', '', 'not a url']) {
      expect(redirectAllowed(ME, url)).toBe(false)
    }
  })
})

describe('mergeRequestHeaders', () => {
  const original = { Accept: '*/*', 'User-Agent': 'x', Cookie: 'a=1' }

  it('answers unchanged when nobody changed a header', () => {
    expect(mergeRequestHeaders(original, [])).toBeUndefined()
    expect(mergeRequestHeaders(original, [reply({})])).toBeUndefined()
    expect(mergeRequestHeaders(original, [reply({ requestHeaders: [{ name: 'accept', value: '*/*' }, { name: 'User-Agent', value: 'x' }, { name: 'Cookie', value: 'a=1' }] })])).toBeUndefined()
  })

  it('applies an added, a changed and a removed header', () => {
    const merged = mergeRequestHeaders(original, [reply({ requestHeaders: [
      { name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'y' }, { name: 'X-New', value: '1' }
    ] })])
    expect(merged).toEqual({ requestHeaders: { Accept: '*/*', 'User-Agent': 'y', 'X-New': '1' } })
  })

  it('lets two extensions change different headers without undoing each other', () => {
    const merged = mergeRequestHeaders(original, [
      reply({ requestHeaders: [{ name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'x' }, { name: 'Cookie', value: 'a=1' }, { name: 'X-One', value: '1' }] }, 10, ME),
      reply({ requestHeaders: [{ name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'x' }, { name: 'X-Two', value: '2' }] }, 20, OTHER)
    ])
    expect(merged).toEqual({ requestHeaders: { Accept: '*/*', 'User-Agent': 'x', 'X-One': '1', 'X-Two': '2' } })
  })

  it('lets the newest install win where two replace the same header', () => {
    const replace = (value: string): unknown => ({ requestHeaders: [{ name: 'Accept', value: '*/*' }, { name: 'Cookie', value: 'a=1' }, { name: 'User-Agent', value }] })
    expect(mergeRequestHeaders(original, [reply(replace('newest'), 20, OTHER), reply(replace('oldest'), 10, ME)]))
      .toEqual({ requestHeaders: { Accept: '*/*', Cookie: 'a=1', 'User-Agent': 'newest' } })
  })

  it('joins a header added twice, Cookie with a semicolon', () => {
    const merged = mergeRequestHeaders(original, [reply({ requestHeaders: [
      { name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'x' }, { name: 'Cookie', value: 'a=1' }, { name: 'cookie', value: 'b=2' }, { name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }
    ] })])
    expect(merged).toEqual({ requestHeaders: { Accept: '*/*', 'User-Agent': 'x', Cookie: 'a=1; b=2', 'X-A': '1, 2' } })
  })

  it('reads a binaryValue as bytes', () => {
    const merged = mergeRequestHeaders({}, [reply({ requestHeaders: [{ name: 'X-Bin', binaryValue: [104, 105] }] })])
    expect(merged).toEqual({ requestHeaders: { 'X-Bin': 'hi' } })
  })

  it('cancels when any listener cancels', () => {
    expect(mergeRequestHeaders(original, [reply({ cancel: true }), reply({ requestHeaders: [] })])).toEqual({ cancel: true })
  })

  it('ignores a whole reply whose header list is malformed, never half-applying it', () => {
    expect(mergeRequestHeaders(original, [reply({ requestHeaders: [{ name: 'X-Ok', value: '1' }, { name: 7, value: 'x' }] })])).toBeUndefined()
    expect(mergeRequestHeaders(original, [reply({ requestHeaders: 'nope' })])).toBeUndefined()
    expect(mergeRequestHeaders(original, [reply({ requestHeaders: [{ name: 'X', binaryValue: [300] }] })])).toBeUndefined()
    expect(mergeRequestHeaders(original, [reply({ requestHeaders: [{ name: 'X' }] })])).toBeUndefined()
  })
})

describe('mergeResponseHeaders', () => {
  const original = { 'content-type': ['text/html'], 'Set-Cookie': ['a=1', 'b=2'] }

  it('answers unchanged when the listeners handed the headers back as they were', () => {
    expect(mergeResponseHeaders(original, [reply({ responseHeaders: [
      { name: 'content-type', value: 'text/html' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }
    ] })])).toBeUndefined()
  })

  it('merges the deltas of two listeners of one extension, as a blocker with two onHeadersReceived listeners does', () => {
    const full = [{ name: 'content-type', value: 'text/html' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }]
    const merged = mergeResponseHeaders(original, [
      reply({ responseHeaders: [...full, { name: 'Content-Security-Policy', value: "script-src 'none'" }] }),
      reply({ responseHeaders: [...full.slice(0, 2), { name: 'X-DNS-Prefetch-Control', value: 'off' }] })
    ])
    expect(merged).toEqual({ responseHeaders: {
      'content-type': ['text/html'],
      'Set-Cookie': ['a=1'],
      'Content-Security-Policy': ["script-src 'none'"],
      'X-DNS-Prefetch-Control': ['off']
    } })
  })

  it('removes a header every value of which was dropped', () => {
    const merged = mergeResponseHeaders(original, [reply({ responseHeaders: [{ name: 'content-type', value: 'text/html' }] })])
    expect(merged).toEqual({ responseHeaders: { 'content-type': ['text/html'] } })
  })

  it('cancels when any listener cancels', () => {
    expect(mergeResponseHeaders(original, [reply({ cancel: true })])).toEqual({ cancel: true })
  })
})
