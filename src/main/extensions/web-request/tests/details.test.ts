import { describe, expect, it } from 'vitest'
import { baseDetails, detailsFor, headersToList, responseHeadersToList, type ElectronRequestDetails } from '../details.js'
import type { ExtraInfoSpec } from '../filter.js'

const NONE: ExtraInfoSpec = { blocking: false, asyncBlocking: false, requestHeaders: false, responseHeaders: false, extraHeaders: false, requestBody: false }
interface TestFrame { readonly parent: TestFrame | null, readonly frameTreeNodeId: number, readonly origin: string }
const frame = (origin: string, parent: TestFrame | null = null, frameTreeNodeId = 1): TestFrame => ({ parent, frameTreeNodeId, origin })

const top = frame('https://site.example')
const request = (overrides: Partial<ElectronRequestDetails> = {}): ElectronRequestDetails => ({
  id: 41, url: 'https://cdn.example/a.js', method: 'GET', resourceType: 'script', webContentsId: 7, frame: top, timestamp: 1700000000000.5, ...overrides
})
const isTab = (id: number): boolean => id === 7

describe('baseDetails', () => {
  it('shapes a subresource request the way Chrome does', () => {
    expect(baseDetails('onBeforeRequest', request(), isTab)).toEqual({
      requestId: '41', url: 'https://cdn.example/a.js', method: 'GET', type: 'script', tabId: 7, frameId: 0, parentFrameId: -1,
      frameType: 'outermost_frame', documentLifecycle: 'active', timeStamp: 1700000000000.5, initiator: 'https://site.example'
    })
  })

  it('maps Electron\'s resource types to Chrome\'s', () => {
    expect(baseDetails('onBeforeRequest', request({ resourceType: 'xhr' }), isTab).type).toBe('xmlhttprequest')
    expect(baseDetails('onBeforeRequest', request({ resourceType: 'webSocket' }), isTab).type).toBe('websocket')
    expect(baseDetails('onBeforeRequest', request({ resourceType: 'cspReport' }), isTab).type).toBe('csp_report')
  })

  it('reports tab -1 for a page that is not a tab, and for no page at all', () => {
    expect(baseDetails('onBeforeRequest', request({ webContentsId: 99 }), isTab).tabId).toBe(-1)
    expect(baseDetails('onBeforeRequest', request({ webContentsId: undefined }), isTab).tabId).toBe(-1)
  })

  it('leaves the initiator out of a top-level navigation', () => {
    const details = baseDetails('onBeforeRequest', request({ resourceType: 'mainFrame' }), isTab)
    expect(details.initiator).toBeUndefined()
    expect(details.type).toBe('main_frame')
  })

  it('names the embedding document as the initiator of a sub_frame', () => {
    const child = frame('https://old-child.example', top, 9)
    const details = baseDetails('onBeforeRequest', request({ resourceType: 'subFrame', frame: child }), isTab)
    expect(details).toMatchObject({ initiator: 'https://site.example', frameId: 9, parentFrameId: 0, frameType: 'sub_frame' })
  })

  it('gives a subresource of an iframe that iframe\'s frame ids', () => {
    const child = frame('https://embed.example', top, 9)
    expect(baseDetails('onBeforeRequest', request({ frame: child }), isTab)).toMatchObject({ initiator: 'https://embed.example', frameId: 9, parentFrameId: 0 })
  })

  it('survives a frame that throws when read and a frame that is gone', () => {
    const throwing = request()
    Object.defineProperty(throwing, 'frame', { get: (): never => { throw new Error('gone') } })
    expect(baseDetails('onBeforeRequest', throwing, isTab)).toMatchObject({ frameId: 0, parentFrameId: -1 })
    expect(baseDetails('onBeforeRequest', request({ frame: null }), isTab).initiator).toBeUndefined()
  })

  it('treats an opaque origin as no initiator', () => {
    expect(baseDetails('onBeforeRequest', request({ frame: frame('null') }), isTab).initiator).toBeUndefined()
  })

  it('carries the response fields of the events that have them, and error and redirect only on theirs', () => {
    const raw = request({ statusCode: 302, statusLine: 'HTTP/1.1 302 Found', fromCache: false, ip: '1.2.3.4', redirectURL: 'https://next.example/', error: 'net::ERR_X' })
    expect(baseDetails('onBeforeRedirect', raw, isTab)).toMatchObject({ statusCode: 302, ip: '1.2.3.4', fromCache: false, redirectUrl: 'https://next.example/' })
    expect(baseDetails('onBeforeRedirect', raw, isTab).error).toBeUndefined()
    expect(baseDetails('onErrorOccurred', raw, isTab).error).toBe('net::ERR_X')
    expect(baseDetails('onErrorOccurred', raw, isTab).redirectUrl).toBeUndefined()
    expect(baseDetails('onCompleted', raw, isTab).error).toBeUndefined()
  })
})

describe('detailsFor', () => {
  it('adds request headers only when the listener asked and the event has them', () => {
    const raw = request({ requestHeaders: { Accept: '*/*', 'X-A': '1' } })
    const base = baseDetails('onBeforeSendHeaders', raw, isTab)
    expect(detailsFor('onBeforeSendHeaders', base, raw, NONE).requestHeaders).toBeUndefined()
    expect(detailsFor('onBeforeSendHeaders', base, raw, { ...NONE, requestHeaders: true }).requestHeaders).toEqual([{ name: 'Accept', value: '*/*' }, { name: 'X-A', value: '1' }])
    expect(detailsFor('onBeforeRequest', base, raw, { ...NONE, requestHeaders: true }).requestHeaders).toBeUndefined()
  })

  it('lists one response header entry per value, and only when asked', () => {
    const raw = request({ statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: { 'Set-Cookie': ['a=1', 'b=2'], 'content-type': ['text/html'] } })
    const base = baseDetails('onHeadersReceived', raw, isTab)
    expect(detailsFor('onHeadersReceived', base, raw, NONE).responseHeaders).toBeUndefined()
    expect(detailsFor('onHeadersReceived', base, raw, { ...NONE, responseHeaders: true }).responseHeaders).toEqual([
      { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }, { name: 'content-type', value: 'text/html' }
    ])
    expect(base.statusCode).toBe(200)
  })

  it('gives the request body as raw bytes, skipping files and blobs, only when asked', () => {
    const raw = request({ method: 'POST', uploadData: [{ bytes: new Uint8Array([1, 2, 3]) }, { file: '/tmp/x' }, { blobUUID: 'u' }] })
    const base = baseDetails('onBeforeRequest', raw, isTab)
    expect(detailsFor('onBeforeRequest', base, raw, NONE).requestBody).toBeUndefined()
    const body = detailsFor('onBeforeRequest', base, raw, { ...NONE, requestBody: true }).requestBody
    expect(body?.raw).toHaveLength(1)
    expect(Array.from(new Uint8Array(body?.raw[0]?.bytes as ArrayBuffer))).toEqual([1, 2, 3])
  })

  it('copies a view into a larger buffer, not the whole buffer', () => {
    const whole = new Uint8Array([9, 9, 4, 5, 9])
    const raw = request({ uploadData: [{ bytes: whole.subarray(2, 4) }] })
    const body = detailsFor('onBeforeRequest', baseDetails('onBeforeRequest', raw, isTab), raw, { ...NONE, requestBody: true }).requestBody
    expect(Array.from(new Uint8Array(body?.raw[0]?.bytes as ArrayBuffer))).toEqual([4, 5])
  })

  it('leaves the body out when there is none', () => {
    const raw = request({ uploadData: [] })
    expect(detailsFor('onBeforeRequest', baseDetails('onBeforeRequest', raw, isTab), raw, { ...NONE, requestBody: true }).requestBody).toBeUndefined()
  })
})

describe('header lists', () => {
  it('tolerates absent headers', () => {
    expect(headersToList(undefined)).toEqual([])
    expect(responseHeadersToList(undefined)).toEqual([])
  })
})
