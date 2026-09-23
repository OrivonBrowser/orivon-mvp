// The routed XMLHttpRequest, re-evaluated from its own source and run over a
// stub orivon.net (routed.test-helpers.ts). A granted host is reached through
// the routed exchange with the XHR spec's states and events; anything else is
// handed to a stand-in for the page's native XMLHttpRequest.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installRoutedEvents } from '../routed-events.js'
import { installXhrResponse } from '../xhr-route-response.js'
import { installXhrRoute } from '../xhr-route.js'
import { bytes, fakeSocket, fakeTarget, installRouted, OK_RESPONSE, refusal, reserialised, settle } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'
import type { FetchRouteTarget } from '../fetch-route-types.js'
import { FakeNativeXhr, installProgressEvent } from './xhr-route.test-helpers.js'

beforeAll(installProgressEvent)
afterEach(() => { vi.useRealTimers() })

const XHR_INSTALLERS = [installRoutedEvents, installXhrResponse, installXhrRoute].map((fn) => reserialised(fn))

type Xhr = XMLHttpRequest
interface XhrTarget extends FetchRouteTarget { XMLHttpRequest: (new () => Xhr) & { readonly DONE: number } }

function xhrTarget (answer: (host: string) => Promise<FakeSocket>, extra: Parameters<typeof fakeTarget>[0] = {}): XhrTarget {
  const target = fakeTarget({ connect: async ({ host }) => await answer(host), connectSecure: async ({ host }) => await answer(host), ...extra }) as XhrTarget
  target.XMLHttpRequest = FakeNativeXhr as unknown as XhrTarget['XMLHttpRequest']
  installRouted(target, XHR_INSTALLERS)
  return target
}

/** Every event an XHR (and its upload) fires, as `type` or `type:readyState`. */
function record (xhr: Xhr): string[] {
  const log: string[] = []
  for (const type of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) {
    xhr.addEventListener(type, () => { log.push(type === 'readystatechange' ? `rsc:${xhr.readyState}` : type) })
  }
  return log
}

async function done (xhr: Xhr): Promise<void> {
  await new Promise<void>((resolve) => { xhr.addEventListener('loadend', () => { resolve() }) })
}

describe('routed XMLHttpRequest -- installation', () => {
  it('replaces the global with the platform\'s interface-object descriptor, and keeps instanceof and the constants working', () => {
    const target = xhrTarget(async () => fakeSocket([OK_RESPONSE]))
    expect(Object.getOwnPropertyDescriptor(target, 'XMLHttpRequest')).toMatchObject({ writable: true, configurable: true, enumerable: false })
    const xhr = new target.XMLHttpRequest()
    expect(xhr).toBeInstanceOf(target.XMLHttpRequest)
    expect(xhr).toBeInstanceOf(EventTarget)
    expect([target.XMLHttpRequest.DONE, xhr.DONE, xhr.readyState]).toEqual([4, 4, 0])
    expect(Object.prototype.toString.call(xhr)).toBe('[object XMLHttpRequest]')
    expect('withCredentials' in xhr && 'upload' in xhr && 'onloadend' in xhr).toBe(true)
  })
})

describe('routed XMLHttpRequest -- a granted host', () => {
  it('walks the spec\'s states and events and exposes the response', async () => {
    const target = xhrTarget(async () => fakeSocket([bytes('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Two: a\r\nx-two: b\r\nContent-Length: 5\r\n\r\nhello')]))
    const xhr = new target.XMLHttpRequest()
    const log = record(xhr)
    xhr.open('GET', 'https://api.example/data')
    xhr.send()
    await done(xhr)
    expect(log).toEqual(['rsc:1', 'loadstart', 'rsc:2', 'rsc:3', 'progress', 'progress', 'rsc:4', 'load', 'loadend'])
    expect([xhr.status, xhr.statusText, xhr.responseText, xhr.response, xhr.responseURL]).toEqual([200, 'OK', 'hello', 'hello', 'https://api.example/data'])
    expect(xhr.getResponseHeader('X-TWO')).toBe('a, b')
    expect(xhr.getAllResponseHeaders()).toBe('content-length: 5\r\ncontent-type: text/plain\r\nx-two: a, b\r\n')
  })

  it('sends headers a page may not set, verbatim', async () => {
    let socket: FakeSocket | undefined
    const target = xhrTarget(async () => { socket = fakeSocket([OK_RESPONSE]); return socket })
    const xhr = new target.XMLHttpRequest()
    xhr.open('GET', 'https://api.example/x')
    xhr.setRequestHeader('Cookie', 'sid=1')
    xhr.setRequestHeader('X-Multi', 'a')
    xhr.setRequestHeader('x-multi', 'b')
    xhr.send()
    await done(xhr)
    expect(socket!.sent).toContain('Cookie: sid=1')
    expect(socket!.sent).toContain('X-Multi: a, b')
  })

  it('gives every responseType its own view of the body', async () => {
    const json = bytes('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n{"a":[1]}')
    const target = xhrTarget(async () => fakeSocket([json]))
    const views: Record<string, unknown> = {}
    for (const type of ['json', 'arraybuffer', 'blob', 'text'] as const) {
      const xhr = new target.XMLHttpRequest()
      xhr.open('GET', 'https://api.example/x')
      xhr.responseType = type
      xhr.send()
      await done(xhr)
      views[type] = xhr.response
    }
    expect(views.json).toEqual({ a: [1] })
    expect((views.arraybuffer as ArrayBuffer).byteLength).toBe(9)
    expect((views.blob as Blob).type).toBe('application/json')
    expect(views.text).toBe('{"a":[1]}')
  })

  it('posts a body with the default content type, and reports upload progress to a listening upload', async () => {
    let socket: FakeSocket | undefined
    const target = xhrTarget(async () => { socket = fakeSocket([OK_RESPONSE]); return socket })
    const xhr = new target.XMLHttpRequest()
    const uploadLog: string[] = []
    for (const type of ['loadstart', 'progress', 'load', 'loadend']) xhr.upload.addEventListener(type, (e) => { uploadLog.push(`${type}:${(e as ProgressEvent).loaded}`) })
    xhr.open('POST', 'https://api.example/x')
    xhr.send('abc')
    await done(xhr)
    expect(socket!.sent).toContain('Content-Type: text/plain;charset=UTF-8')
    expect(socket!.sent.endsWith('\r\n\r\nabc')).toBe(true)
    expect(uploadLog).toEqual(['loadstart:0', 'progress:3', 'load:3', 'loadend:3'])
  })

  it('invokes handler attributes, and a replaced handler replaces the old one', async () => {
    const target = xhrTarget(async () => fakeSocket([OK_RESPONSE]))
    const xhr = new target.XMLHttpRequest()
    const calls: string[] = []
    xhr.onload = () => { calls.push('first') }
    xhr.onload = function (this: Xhr) { calls.push(this === xhr ? 'second' : 'wrong this') }
    xhr.open('GET', 'https://api.example/x')
    xhr.send()
    await done(xhr)
    expect(calls).toEqual(['second'])
  })

  it('fires error with status 0 on a network failure', async () => {
    const target = xhrTarget(async () => { throw refusal('unreachable') })
    const xhr = new target.XMLHttpRequest()
    const log = record(xhr)
    xhr.open('GET', 'https://down.example/')
    xhr.send()
    await done(xhr)
    expect(log).toEqual(['rsc:1', 'loadstart', 'rsc:4', 'error', 'loadend'])
    expect(xhr.status).toBe(0)
  })

  it('abort() fires abort and loadend, then returns to UNSENT', async () => {
    const target = xhrTarget(async () => fakeSocket([], true))
    const xhr = new target.XMLHttpRequest()
    const log = record(xhr)
    xhr.open('GET', 'https://api.example/x')
    xhr.send()
    await settle()
    xhr.abort()
    expect(log).toEqual(['rsc:1', 'loadstart', 'rsc:4', 'abort', 'loadend'])
    expect([xhr.readyState, xhr.status]).toEqual([0, 0])
  })

  it('times out after `timeout` ms with timeout and loadend', async () => {
    vi.useFakeTimers()
    const target = xhrTarget(async () => fakeSocket([], true))
    const xhr = new target.XMLHttpRequest()
    const log = record(xhr)
    xhr.open('GET', 'https://api.example/x')
    xhr.timeout = 1_000
    xhr.send()
    await vi.advanceTimersByTimeAsync(999)
    expect(log).toEqual(['rsc:1', 'loadstart'])
    await vi.advanceTimersByTimeAsync(2)
    expect(log).toEqual(['rsc:1', 'loadstart', 'rsc:4', 'timeout', 'loadend'])
  })

  it('refuses setRequestHeader before open, as the platform does', () => {
    const target = xhrTarget(async () => fakeSocket([OK_RESPONSE]))
    expect(() => { new target.XMLHttpRequest().setRequestHeader('a', 'b') }).toThrow(/OPENED/)
  })
})

describe('routed XMLHttpRequest -- the native path', () => {
  it('hands a host the app was not granted to the native XMLHttpRequest, replaying what the page set, without doubling loadstart', async () => {
    const target = xhrTarget(async () => { throw refusal('denied') })
    const xhr = new target.XMLHttpRequest()
    const log = record(xhr)
    xhr.open('POST', 'https://not-granted.example/x')
    xhr.setRequestHeader('X-App', '1')
    xhr.withCredentials = true
    xhr.send('payload')
    await settle()
    const native = FakeNativeXhr.last!
    expect(native.calls).toEqual([['open', 'POST', 'https://not-granted.example/x', true], ['setRequestHeader', 'X-App', '1'], ['send', 'payload']])
    expect(native.withCredentials).toBe(true)
    native.finish(200, 'native body')
    expect(log).toEqual(['rsc:1', 'loadstart', 'rsc:4', 'load', 'loadend'])
    expect([xhr.status, xhr.responseText]).toEqual([200, 'native body'])
  })

  it('opens a same-origin request natively, straight away', () => {
    const target = xhrTarget(async () => { throw new Error('must not dial') }, { location: { origin: 'https://app.example', href: 'https://app.example/' } })
    const xhr = new target.XMLHttpRequest()
    const log = record(xhr)
    xhr.open('GET', '/local.json')
    expect(FakeNativeXhr.last!.calls[0]).toEqual(['open', 'GET', 'https://app.example/local.json', true])
    expect(log).toEqual(['rsc:1'])
  })

  it('sends a synchronous request natively', () => {
    const target = xhrTarget(async () => { throw new Error('must not dial') })
    const xhr = new target.XMLHttpRequest()
    xhr.open('GET', 'https://api.example/x', false)
    expect(FakeNativeXhr.last!.calls[0]).toEqual(['open', 'GET', 'https://api.example/x', false])
  })
})
