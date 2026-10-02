// A routed request that fails leaves one console line naming the method, the
// origin and path, and the reason, the way Chromium prints a net error for a
// native one. The TypeError the page catches stays `Failed to fetch`: the
// reason rides on `cause`, where a toast that prints only the error never
// shows it.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installRoutedEvents } from '../events.js'
import { installEventSourceRoute } from '../eventsource.js'
import { installXhrResponse } from '../xhr-response.js'
import { installXhrRoute } from '../xhr.js'
import { bytes, fakeSocket, fakeTarget, installRouted, OK_RESPONSE, refusal, reserialised, settle } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'
import type { FetchRouteTarget } from '../types.js'
import { FakeNativeXhr, installProgressEvent } from './xhr.test-helpers.js'

beforeAll(installProgressEvent)
afterEach(() => { vi.restoreAllMocks() })

const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'unreachable', platformCode: 'ECONNRESET' })

function logged (): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('a routed fetch that fails', () => {
  it('logs the method, origin, path and reason once when the dial dies with an errno, and still rejects with Failed to fetch', async () => {
    const spy = logged()
    const target = fakeTarget({ connectSecure: async () => { throw reset() } })
    installRouted(target)
    const error = await target.fetch!('https://api.example/v1/items?token=secret', { method: 'POST', body: 'x' }).catch((e: unknown) => e) as TypeError
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toBe('Failed to fetch')
    expect((error.cause as Error).message).toContain('ECONNRESET')
    expect(spy).toHaveBeenCalledTimes(1)
    const line = String(spy.mock.calls[0]![0])
    expect(line).toContain('POST https://api.example/v1/items')
    expect(line).toContain('ECONNRESET')
    expect(line).not.toContain('secret')
  })

  it('logs a failed redirect hop and a response cut short, one line each', async () => {
    const spy = logged()
    const redirecting = fakeTarget({ connectSecure: async () => fakeSocket([bytes('HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n')]) })
    installRouted(redirecting)
    await expect(redirecting.fetch!('https://api.example/a', { redirect: 'error' })).rejects.toMatchObject({ message: 'Failed to fetch' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]![0])).toMatch(/^GET https:\/\/api\.example\/a failed: .*redirect/)

    const cut = fakeTarget({ connectSecure: async () => fakeSocket([bytes('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort')]) })
    installRouted(cut)
    const response = await cut.fetch!('https://api.example/b')
    expect(spy).toHaveBeenCalledTimes(1)
    await expect(response.text()).rejects.toMatchObject({ message: 'Failed to fetch' })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(String(spy.mock.calls[1]![0])).toMatch(/^GET https:\/\/api\.example\/b failed: .*closed before the response body completed/)
  })

  it('stays quiet for a success, an abort and a host handed to the native path', async () => {
    const spy = logged()
    const ok = fakeTarget({ connectSecure: async () => fakeSocket([OK_RESPONSE]) })
    installRouted(ok)
    await (await ok.fetch!('https://api.example/x')).text()

    const controller = new AbortController()
    const held = fakeTarget({ connectSecure: async () => fakeSocket([], true) })
    installRouted(held)
    const pending = held.fetch!('https://api.example/x', { signal: controller.signal }).catch((e: unknown) => e)
    await settle()
    controller.abort()
    expect(await pending).toMatchObject({ name: 'AbortError' })

    const denied = fakeTarget({ connectSecure: async () => { throw refusal('denied') }, nativeFetch: async () => new Response('native') })
    installRouted(denied)
    await denied.fetch!('https://not-granted.example/')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('the other routed entry points', () => {
  it('logs a routed XMLHttpRequest whose dial dies', async () => {
    const spy = logged()
    const target = fakeTarget({ connectSecure: async () => { throw reset() } }) as FetchRouteTarget & { XMLHttpRequest: new () => XMLHttpRequest }
    target.XMLHttpRequest = FakeNativeXhr as unknown as typeof target.XMLHttpRequest
    installRouted(target, [installRoutedEvents, installXhrResponse, installXhrRoute].map((fn) => reserialised(fn)))
    const xhr = new target.XMLHttpRequest()
    const finished = new Promise<void>((resolve) => { xhr.addEventListener('loadend', () => { resolve() }) })
    xhr.open('GET', 'https://api.example/data?x=1')
    xhr.send()
    await finished
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]![0])).toMatch(/^GET https:\/\/api\.example\/data failed: .*ECONNRESET/)
  })

  it('logs a routed EventSource whose dial dies, once for the attempt', async () => {
    const spy = logged()
    const target = fakeTarget({ connectSecure: async () => { throw reset() } }) as FetchRouteTarget & { EventSource: new (url: string) => EventSource }
    target.EventSource = class extends EventTarget {} as unknown as typeof target.EventSource
    installRouted(target, [installRoutedEvents, installEventSourceRoute].map((fn) => reserialised(fn)))
    const source = new target.EventSource('https://stream.example/feed')
    await settle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]![0])).toMatch(/^GET https:\/\/stream\.example\/feed failed: .*ECONNRESET/)
    ;(source as unknown as { close: () => void }).close()
  })
})
