import { describe, expect, it } from 'vitest'
import { filterMatches, isWebRequestEvent, parseExtraInfoSpec, parseRequestFilter, type RequestFilter } from '../filter.js'

function filterOf (raw: unknown): RequestFilter {
  const parsed = parseRequestFilter(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

const request = (url: string, type = 'script', tabId = 3): { url: string, type: string, tabId: number } => ({ url, type, tabId })

describe('parseRequestFilter', () => {
  it('accepts the filter a blocker passes, ws and wss patterns included', () => {
    const parsed = parseRequestFilter({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'], types: ['main_frame', 'websocket'] })
    expect(parsed.ok).toBe(true)
  })

  it('requires a non-empty urls list of match patterns', () => {
    expect(parseRequestFilter({}).ok).toBe(false)
    expect(parseRequestFilter({ urls: [] }).ok).toBe(false)
    expect(parseRequestFilter({ urls: 'https://*/*' }).ok).toBe(false)
    expect(parseRequestFilter({ urls: ['not a pattern'] }).ok).toBe(false)
    expect(parseRequestFilter({ urls: [3] }).ok).toBe(false)
  })

  it('rejects a type Chrome does not name, a non-integer tab id and a non-object filter', () => {
    expect(parseRequestFilter({ urls: ['<all_urls>'], types: ['video'] }).ok).toBe(false)
    expect(parseRequestFilter({ urls: ['<all_urls>'], types: 'script' }).ok).toBe(false)
    expect(parseRequestFilter({ urls: ['<all_urls>'], tabId: 1.5 }).ok).toBe(false)
    expect(parseRequestFilter(null).ok).toBe(false)
    expect(parseRequestFilter([]).ok).toBe(false)
  })

  it('accepts windowId and drops it', () => {
    const filter = filterOf({ urls: ['<all_urls>'], windowId: 4 })
    expect(Object.keys(filter)).toEqual(['urls'])
  })
})

describe('parseExtraInfoSpec', () => {
  it('reads the names an event accepts', () => {
    const parsed = parseExtraInfoSpec('onBeforeSendHeaders', ['blocking', 'requestHeaders', 'extraHeaders'])
    expect(parsed).toEqual({ ok: true, value: expect.objectContaining({ blocking: true, requestHeaders: true, extraHeaders: true, responseHeaders: false }) })
  })

  it('treats a missing spec as empty', () => {
    expect(parseExtraInfoSpec('onCompleted', undefined)).toEqual({ ok: true, value: expect.objectContaining({ blocking: false }) })
  })

  it('refuses a name the event does not take, and a non-array', () => {
    expect(parseExtraInfoSpec('onCompleted', ['blocking']).ok).toBe(false)
    expect(parseExtraInfoSpec('onBeforeRequest', ['responseHeaders']).ok).toBe(false)
    expect(parseExtraInfoSpec('onHeadersReceived', 'blocking').ok).toBe(false)
    expect(parseExtraInfoSpec('onHeadersReceived', [1]).ok).toBe(false)
  })

  it('accepts asyncBlocking on onAuthRequired only', () => {
    expect(parseExtraInfoSpec('onAuthRequired', ['asyncBlocking']).ok).toBe(true)
    expect(parseExtraInfoSpec('onBeforeRequest', ['asyncBlocking']).ok).toBe(false)
  })
})

describe('isWebRequestEvent', () => {
  it('names the nine events and nothing inherited', () => {
    expect(isWebRequestEvent('onCompleted')).toBe(true)
    expect(isWebRequestEvent('onActionIgnored')).toBe(false)
    expect(isWebRequestEvent('constructor')).toBe(false)
    expect(isWebRequestEvent(7)).toBe(false)
  })
})

describe('filterMatches', () => {
  it('matches by URL pattern', () => {
    const filter = filterOf({ urls: ['https://*.example.com/ads/*'] })
    expect(filterMatches(filter, request('https://cdn.example.com/ads/a.js'))).toBe(true)
    expect(filterMatches(filter, request('https://cdn.example.com/other.js'))).toBe(false)
    expect(filterMatches(filter, request('http://cdn.example.com/ads/a.js'))).toBe(false)
  })

  it('covers ws and wss with an explicit pattern', () => {
    const filter = filterOf({ urls: ['ws://*/*', 'wss://*/*'] })
    expect(filterMatches(filter, request('wss://sock.example/x', 'websocket'))).toBe(true)
    expect(filterMatches(filter, request('ws://sock.example/x', 'websocket'))).toBe(true)
    expect(filterMatches(filter, request('https://sock.example/x'))).toBe(false)
  })

  it('lets <all_urls> cover ws and wss as well as http, https and ftp, and never file', () => {
    const filter = filterOf({ urls: ['<all_urls>'] })
    for (const url of ['http://a.example/', 'https://a.example/', 'ws://a.example/', 'wss://a.example/', 'ftp://a.example/']) {
      expect(filterMatches(filter, request(url))).toBe(true)
    }
    expect(filterMatches(filter, request('file:///etc/passwd'))).toBe(false)
    expect(filterMatches(filter, request('not a url'))).toBe(false)
  })

  it('a *:// pattern covers http and https and not ws', () => {
    const filter = filterOf({ urls: ['*://a.example/*'] })
    expect(filterMatches(filter, request('https://a.example/x'))).toBe(true)
    expect(filterMatches(filter, request('ws://a.example/x'))).toBe(false)
  })

  it('matches an extension\'s own page by its explicit pattern', () => {
    const filter = filterOf({ urls: ['chrome-extension://abc/web_accessible_resources/*'] })
    expect(filterMatches(filter, request('chrome-extension://abc/web_accessible_resources/x.js'))).toBe(true)
    expect(filterMatches(filter, request('chrome-extension://other/web_accessible_resources/x.js'))).toBe(false)
  })

  it('applies types and tabId when given', () => {
    const filter = filterOf({ urls: ['<all_urls>'], types: ['image'], tabId: 3 })
    expect(filterMatches(filter, request('https://a.example/x.png', 'image', 3))).toBe(true)
    expect(filterMatches(filter, request('https://a.example/x.js', 'script', 3))).toBe(false)
    expect(filterMatches(filter, request('https://a.example/x.png', 'image', 4))).toBe(false)
  })
})
