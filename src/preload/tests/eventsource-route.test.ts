// The routed EventSource, re-evaluated from its own source and run over a
// stub orivon.net (routed.test-helpers.ts): parsing, reconnection with
// Last-Event-ID, and the native path for everything the routed one does not take.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRoutedEvents } from '../routed-events.js'
import { installEventSourceRoute } from '../eventsource-route.js'
import { bytes, fakeSocket, fakeTarget, installRouted, refusal, reserialised, settle } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'
import type { FetchRouteTarget } from '../fetch-route-types.js'

afterEach(() => { vi.useRealTimers() })

const ES_INSTALLERS = [installRoutedEvents, installEventSourceRoute].map((fn) => reserialised(fn))

class FakeNativeEventSource extends EventTarget {
  static last: FakeNativeEventSource | undefined
  readyState = 0
  closed = false
  constructor (readonly url: string, readonly init?: EventSourceInit) { super(); FakeNativeEventSource.last = this }
  close (): void { this.closed = true; this.readyState = 2 }
}

type Source = EventSource
interface EsTarget extends FetchRouteTarget { EventSource: (new (url: string, init?: EventSourceInit) => Source) & { readonly CLOSED: number } }

function esTarget (dial: () => Promise<FakeSocket>): EsTarget {
  const target = fakeTarget({ connect: dial, connectSecure: dial }) as EsTarget
  target.EventSource = FakeNativeEventSource as unknown as EsTarget['EventSource']
  installRouted(target, ES_INSTALLERS)
  return target
}

const STREAM_HEAD = 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n'

function messages (source: Source, types: string[] = ['message']): Array<{ type: string, data: string, lastEventId: string }> {
  const seen: Array<{ type: string, data: string, lastEventId: string }> = []
  for (const type of types) source.addEventListener(type, (e) => { const m = e as MessageEvent; seen.push({ type, data: String(m.data), lastEventId: m.lastEventId }) })
  return seen
}

describe('routed EventSource -- parsing', () => {
  it('opens, then dispatches events as the spec parses them, whatever the line endings and chunk boundaries', async () => {
    let socket: FakeSocket | undefined
    const target = esTarget(async () => { socket = fakeSocket([bytes(STREAM_HEAD)], true); return socket })
    const source = new target.EventSource('https://stream.example/feed')
    const seen = messages(source, ['message', 'price'])
    let opened = false
    source.onopen = () => { opened = true }
    await settle()
    expect(opened).toBe(true)
    expect(source.readyState).toBe(1)

    socket!.push(bytes(': comment\r\ndata: one\r'))
    socket!.push(bytes('\ndata:two\n\nevent: price\nid: 7\ndata: 42\r\n\r\n'))
    socket!.push(bytes('data\n\nid: 8\n\n'))
    await settle()
    expect(seen).toEqual([
      { type: 'message', data: 'one\ntwo', lastEventId: '' },
      { type: 'price', data: '42', lastEventId: '7' },
      { type: 'message', data: '', lastEventId: '7' }
    ])
  })

  it('fails without reconnecting on a non-200 status or a wrong content type', async () => {
    for (const head of ['HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n']) {
      let dials = 0
      const target = esTarget(async () => { dials++; return fakeSocket([bytes(head)]) })
      const source = new target.EventSource('https://stream.example/feed')
      let errors = 0
      source.onerror = () => { errors++ }
      await settle()
      expect([source.readyState, errors, dials]).toEqual([2, 1, 1])
    }
  })
})

describe('routed EventSource -- reconnection', () => {
  it('reconnects after `retry:` ms when the stream ends, sending the last event id', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const target = esTarget(async () => {
      const socket = sockets.length === 0
        ? fakeSocket([bytes(`${STREAM_HEAD}retry: 1500\nid: abc\ndata: x\n\n`)])
        : fakeSocket([bytes(STREAM_HEAD)], true)
      sockets.push(socket)
      return socket
    })
    const source = new target.EventSource('https://stream.example/feed')
    const states: number[] = []
    source.onerror = () => { states.push(source.readyState) }
    await vi.advanceTimersByTimeAsync(10)
    expect(states).toEqual([0])
    await vi.advanceTimersByTimeAsync(1_400)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.sent).toContain('Last-Event-ID: abc')
    expect(sockets[1]!.sent).toContain('Accept: text/event-stream')
  })

  it('close() stops the stream and any reconnection', async () => {
    let socket: FakeSocket | undefined
    const target = esTarget(async () => { socket = fakeSocket([bytes(STREAM_HEAD)], true); return socket })
    const source = new target.EventSource('https://stream.example/feed')
    await settle()
    source.close()
    await settle()
    expect(source.readyState).toBe(target.EventSource.CLOSED)
    expect(socket!.closed).toBe(true)
  })
})

describe('routed EventSource -- the native path', () => {
  it('hands a host the app was not granted to the native EventSource, forwarding named events the page listens for', async () => {
    const target = esTarget(async () => { throw refusal('denied') })
    const source = new target.EventSource('https://not-granted.example/feed', { withCredentials: true })
    const seen = messages(source, ['message', 'tick'])
    await settle()
    const native = FakeNativeEventSource.last!
    expect([native.url, native.init?.withCredentials]).toEqual(['https://not-granted.example/feed', true])
    native.dispatchEvent(new MessageEvent('tick', { data: 'd', lastEventId: '1' }))
    expect(seen).toEqual([{ type: 'tick', data: 'd', lastEventId: '1' }])
    source.close()
    expect(native.closed).toBe(true)
  })

  it('opens a same-origin stream natively, straight away', () => {
    const fresh = fakeTarget({ location: { origin: 'https://app.example', href: 'https://app.example/' } }) as EsTarget
    fresh.EventSource = FakeNativeEventSource as unknown as EsTarget['EventSource']
    installRouted(fresh, ES_INSTALLERS)
    const source = new fresh.EventSource('/events')
    expect(FakeNativeEventSource.last!.url).toBe('https://app.example/events')
    expect(source).toBeInstanceOf(fresh.EventSource)
  })
})
