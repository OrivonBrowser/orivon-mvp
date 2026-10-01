import type { CallbackResponse, OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createUpgradeTracker } from '../https-fallback.js'
import { createHttpsExemptions } from '../https-state.js'
import { createNetHandlers } from '../net-handlers.js'
import type { NetSettings } from '../net-handlers.js'

type Values = Record<string, string | boolean>
const DEFAULTS: Values = { 'privacy.cookies': 'all', 'privacy.globalPrivacyControl': false, 'privacy.doNotTrack': false, 'privacy.httpsOnly': false }

function rig (values: Values = {}, isDevHost: (host: string) => boolean = () => false) {
  const current: Values = { ...DEFAULTS, ...values }
  const settings: NetSettings = { get: (key) => current[key] ?? false }
  const loopDetected = vi.fn()
  const exemptions = createHttpsExemptions()
  const handlers = createNetHandlers({ settings, exemptions, tracker: createUpgradeTracker(), isDevHost, loopDetected })
  return { handlers, current, loopDetected, exemptions }
}

const request = (url: string, extra: Partial<OnBeforeRequestListenerDetails> = {}): OnBeforeRequestListenerDetails => ({ id: 1, url, method: 'GET', resourceType: 'mainFrame', referrer: '', timestamp: 0, uploadData: [], webContentsId: 7, ...extra })
const send = (url: string, resourceType: OnBeforeSendHeadersListenerDetails['resourceType'], top: string | undefined, id = 1): OnBeforeSendHeadersListenerDetails => ({
  id, url, method: 'GET', resourceType, referrer: '', timestamp: 0, requestHeaders: {}, ...(top === undefined ? {} : { frame: { top: { url: top } } as unknown as NonNullable<OnBeforeSendHeadersListenerDetails['frame']> })
})
const receive = (url: string, resourceType: OnHeadersReceivedListenerDetails['resourceType'], top: string | undefined, id = 1): OnHeadersReceivedListenerDetails => ({
  id, url, method: 'GET', resourceType, referrer: '', timestamp: 0, statusLine: 'HTTP/1.1 200', statusCode: 200, responseHeaders: {}, ...(top === undefined ? {} : { frame: { top: { url: top } } as unknown as NonNullable<OnHeadersReceivedListenerDetails['frame']> })
})

describe('the header signals', () => {
  it('hand the request back untouched while both are off', () => {
    const { handlers } = rig()
    const seed = { requestHeaders: { Accept: '*/*' } }
    expect(handlers.beforeSendHeaders(send('https://a.example/', 'xhr', 'https://a.example/'), seed)).toBe(seed)
  })

  it('add Sec-GPC and DNT when they are on, and follow the setting at once', () => {
    const { handlers, current } = rig({ 'privacy.globalPrivacyControl': true })
    const seed = { requestHeaders: {} as Record<string, string> }
    expect(handlers.beforeSendHeaders(send('https://a.example/', 'mainFrame', undefined), seed)).toEqual({ requestHeaders: { 'Sec-GPC': '1' } })
    current['privacy.globalPrivacyControl'] = false
    current['privacy.doNotTrack'] = true
    expect(handlers.beforeSendHeaders(send('https://a.example/', 'mainFrame', undefined), seed)).toEqual({ requestHeaders: { DNT: '1' } })
  })
})

describe('third-party cookie blocking', () => {
  const blocking = { 'privacy.cookies': 'blockThirdParty' }

  it('does nothing while every cookie is allowed', () => {
    const { handlers } = rig()
    const seed = { requestHeaders: { Cookie: 'a=1' } }
    expect(handlers.beforeSendHeaders(send('https://tracker.example/p', 'image', 'https://shop.example/'), seed)).toBe(seed)
    const reply = { responseHeaders: { 'Set-Cookie': ['a=1'] } }
    expect(handlers.headersReceived(receive('https://tracker.example/p', 'image', 'https://shop.example/'), reply)).toBe(reply)
  })

  it('strips Cookie from a cross-site request and Set-Cookie from its response', () => {
    const { handlers } = rig(blocking)
    const sent = handlers.beforeSendHeaders(send('https://tracker.example/p', 'image', 'https://shop.example/'), { requestHeaders: { Cookie: 'a=1', Accept: '*/*' } })
    expect(sent.requestHeaders).toEqual({ Accept: '*/*' })
    const got = handlers.headersReceived(receive('https://tracker.example/p', 'image', 'https://shop.example/'), { responseHeaders: { 'Set-Cookie': ['a=1'], 'Content-Type': ['image/gif'] } })
    expect(got.responseHeaders).toEqual({ 'Content-Type': ['image/gif'] })
  })

  it('leaves a first-party request and its response alone', () => {
    const { handlers } = rig(blocking)
    const seed = { requestHeaders: { Cookie: 'a=1' } }
    expect(handlers.beforeSendHeaders(send('https://cdn.shop.example/p', 'image', 'https://www.shop.example/'), seed)).toBe(seed)
    const reply = { responseHeaders: { 'Set-Cookie': ['a=1'] } }
    expect(handlers.headersReceived(receive('https://cdn.shop.example/p', 'image', 'https://www.shop.example/'), reply)).toBe(reply)
  })

  it('never strips a main-frame navigation, even to another site', () => {
    const { handlers } = rig(blocking)
    const seed = { requestHeaders: { Cookie: 'a=1' } }
    expect(handlers.beforeSendHeaders(send('https://other.example/', 'mainFrame', 'https://shop.example/'), seed)).toBe(seed)
  })

  it('strips a response by the id it saw as third-party even when the frame is gone', () => {
    const { handlers } = rig(blocking)
    handlers.beforeSendHeaders(send('https://tracker.example/p', 'image', 'https://shop.example/', 42), { requestHeaders: {} })
    const got = handlers.headersReceived(receive('https://tracker.example/p', 'image', undefined, 42), { responseHeaders: { 'set-cookie': ['a=1'] } })
    expect(got.responseHeaders).toEqual({})
  })

  it('fails open for a request it cannot place', () => {
    const { handlers } = rig(blocking)
    const seed = { requestHeaders: { Cookie: 'a=1' } }
    expect(handlers.beforeSendHeaders(send('https://tracker.example/p', 'xhr', undefined), seed)).toBe(seed)
  })
})

describe('HTTPS-only', () => {
  const on = { 'privacy.httpsOnly': true }
  const blank: CallbackResponse = {}

  it('passes everything through while off', () => {
    const { handlers } = rig()
    expect(handlers.beforeRequest(request('http://example.com/'), blank)).toBe(blank)
  })

  it('redirects a main-frame http navigation to https', () => {
    const { handlers } = rig(on)
    expect(handlers.beforeRequest(request('http://example.com/a?b=1'), blank)).toEqual({ redirectURL: 'https://example.com/a?b=1' })
  })

  it('leaves subresources, https and every exempt address alone', () => {
    const { handlers } = rig(on)
    for (const r of [request('http://example.com/a.png', { resourceType: 'image' }), request('https://example.com/'), request('http://127.0.0.1:8000/'), request('http://localhost:3000/'), request('http://192.168.0.2/'), request('http://vitalik.eth/')]) {
      expect(handlers.beforeRequest(r, blank)).toBe(blank)
    }
  })

  it('honours the person\'s session exemption and this run\'s developer names', () => {
    const { handlers, exemptions } = rig(on, (host) => host === 'dev.example')
    exemptions.add('kept.example')
    expect(handlers.beforeRequest(request('http://kept.example/'), blank)).toBe(blank)
    expect(handlers.beforeRequest(request('http://dev.example/'), blank)).toBe(blank)
    expect(handlers.beforeRequest(request('http://other.example/'), blank)).not.toBe(blank)
  })

  it('cancels the second upgrade of one address within five seconds and says so', () => {
    const { handlers, loopDetected } = rig(on)
    const contents = { id: 7 } as unknown as WebContents
    expect(handlers.beforeRequest(request('http://loop.example/', { webContents: contents }), blank)).toEqual({ redirectURL: 'https://loop.example/' })
    expect(handlers.beforeRequest(request('http://loop.example/', { webContents: contents }), blank)).toEqual({ cancel: true })
    expect(loopDetected).toHaveBeenCalledWith(contents, 'http://loop.example/')
  })
})
