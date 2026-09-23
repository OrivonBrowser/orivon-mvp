// The routed fetch's flow control: the idle timeout, queueing at the
// origin's socket allowance, request bodies of every shape, and a response
// body that streams rather than being collected first.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTED_IDLE_TIMEOUT_MS } from '../routed-core.js'
import { ROUTED_LIMIT_RETRY_MS, ROUTED_QUEUE_MAX_WAIT_MS } from '../routed-dial.js'
import { bytes, fakeSocket, fakeTarget, installRouted, OK_RESPONSE, refusal, settle } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'
import type { FetchRouteTarget } from '../fetch-route-types.js'

afterEach(() => { vi.useRealTimers() })

function holdingTarget (): { target: FetchRouteTarget, sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const target = fakeTarget({ connectSecure: async () => { const s = fakeSocket([], true); sockets.push(s); return s } })
  installRouted(target)
  return { target, sockets }
}

describe('routed fetch -- the idle timeout', () => {
  it(`fails like a network error, and closes the socket, after ${ROUTED_IDLE_TIMEOUT_MS} ms with nothing received`, async () => {
    vi.useFakeTimers()
    const { target, sockets } = holdingTarget()
    const outcome = target.fetch!('https://api.example/x').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(ROUTED_IDLE_TIMEOUT_MS - 1)
    expect(sockets[0]!.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await outcome).toMatchObject({ name: 'TypeError', message: 'Failed to fetch' })
    expect(sockets[0]!.closed).toBe(true)
  })

  it('restarts with every chunk, so a slow but live body is never cut off', async () => {
    vi.useFakeTimers()
    const { target, sockets } = holdingTarget()
    const pending = target.fetch!('https://api.example/x')
    await vi.advanceTimersByTimeAsync(1)
    sockets[0]!.push(bytes('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n'))
    const response = await pending
    const text = response.text()
    await vi.advanceTimersByTimeAsync(ROUTED_IDLE_TIMEOUT_MS - 1)
    sockets[0]!.push(bytes('o'))
    await vi.advanceTimersByTimeAsync(ROUTED_IDLE_TIMEOUT_MS - 1)
    sockets[0]!.push(bytes('k'))
    expect(await text).toBe('ok')
  })

  it('stays out of the way of a caller that brought its own signal', async () => {
    vi.useFakeTimers()
    const { target, sockets } = holdingTarget()
    let settled = false
    void target.fetch!('https://api.example/x', { signal: new AbortController().signal }).finally(() => { settled = true }).catch(() => {})
    await vi.advanceTimersByTimeAsync(ROUTED_IDLE_TIMEOUT_MS * 2)
    expect(settled).toBe(false)
    expect(sockets[0]!.closed).toBe(false)
  })
})

/** A dialler with `allowance` sockets: past it, dials are refused 'limit' exactly as the broker refuses them. */
function limitedTarget (allowance: number): { target: FetchRouteTarget, open: FakeSocket[], dials: () => number } {
  const open: FakeSocket[] = []
  let dials = 0
  const target = fakeTarget({
    connectSecure: async () => {
      dials++
      if (open.filter((s) => !s.closed).length >= allowance) throw refusal('limit')
      const socket = fakeSocket([], true)
      open.push(socket)
      return socket
    }
  })
  installRouted(target)
  return { target, open, dials: () => dials }
}

function answer (socket: FakeSocket, text: string): void {
  socket.push(bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${text.length}\r\n\r\n${text}`))
}

describe('routed fetch -- queueing at the socket allowance', () => {
  it('queues past the allowance, in order, and never surfaces \'limit\'', async () => {
    const { target, open } = limitedTarget(2)
    const results = ['a', 'b', 'c', 'd'].map(async (path) => await (await target.fetch!(`https://api.example/${path}`)).text())
    await settle()
    expect(open).toHaveLength(2)

    answer(open[0]!, 'A')
    answer(open[1]!, 'B')
    await settle()
    expect(open.map((s) => /GET \/(\w)/.exec(s.sent)?.[1])).toEqual(['a', 'b', 'c', 'd'])
    answer(open[2]!, 'C')
    answer(open[3]!, 'D')
    expect(await Promise.all(results)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('wakes one waiter per freed socket, not the whole queue', async () => {
    const { target, open, dials } = limitedTarget(1)
    const pending = [1, 2, 3, 4, 5].map(async (n) => await target.fetch!(`https://api.example/${n}`))
    await settle()
    const before = dials()
    answer(open[0]!, 'x')
    await settle()
    expect(dials() - before).toBe(1)
    for (let i = 1; i < 5; i++) { answer(open[i]!, 'x'); await settle() }
    await Promise.all(pending)
  })

  it('retries after a back-off when the allowance is held by something that is not routed', async () => {
    vi.useFakeTimers()
    let refusals = 1
    const target = fakeTarget({
      connectSecure: async () => {
        if (refusals-- > 0) throw refusal('limit')
        return fakeSocket([OK_RESPONSE])
      }
    })
    installRouted(target)
    const pending = target.fetch!('https://api.example/x')
    await vi.advanceTimersByTimeAsync(ROUTED_LIMIT_RETRY_MS + 1)
    expect(await (await pending).text()).toBe('hello')
  })

  it(`gives up like a network error after ${ROUTED_QUEUE_MAX_WAIT_MS} ms in the queue`, async () => {
    vi.useFakeTimers()
    const target = fakeTarget({ connectSecure: async () => { throw refusal('limit') } })
    installRouted(target)
    const outcome = target.fetch!('https://api.example/x').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(ROUTED_QUEUE_MAX_WAIT_MS + ROUTED_LIMIT_RETRY_MS)
    expect(await outcome).toMatchObject({ name: 'TypeError', message: 'Failed to fetch' })
  })

  it('leaves the queue at once when its signal aborts', async () => {
    const { target, open } = limitedTarget(1)
    const first = target.fetch!('https://api.example/1')
    const controller = new AbortController()
    const queued = target.fetch!('https://api.example/2', { signal: controller.signal })
    const third = target.fetch!('https://api.example/3')
    await settle()
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    answer(open[0]!, 'x')
    await first
    await settle()
    expect(open[1]!.sent).toMatch(/^GET \/3 /)
    answer(open[1]!, 'y')
    await third
  })
})

describe('routed fetch -- request bodies of every shape', () => {
  async function sent (body: unknown, method = 'POST'): Promise<string> {
    let socket: FakeSocket | undefined
    const target = fakeTarget({ connectSecure: async () => { socket = fakeSocket([OK_RESPONSE]); return socket } })
    installRouted(target)
    await target.fetch!('https://api.example/x', { method, body })
    return socket!.sent
  }

  it('sends a Blob with its own type', async () => {
    const wire = await sent(new Blob(['blob-bytes'], { type: 'application/x-test' }))
    expect(wire).toContain('Content-Type: application/x-test')
    expect(wire.endsWith('\r\n\r\nblob-bytes')).toBe(true)
  })

  it('sends FormData as multipart with a boundary', async () => {
    const form = new FormData()
    form.append('field', 'value')
    const wire = await sent(form)
    const boundary = /Content-Type: multipart\/form-data; boundary=(\S+)/.exec(wire)?.[1]
    expect(boundary).toBeDefined()
    expect(wire).toContain(`--${boundary!}`)
    expect(wire).toContain('name="field"')
  })

  it('sends URLSearchParams form-encoded', async () => {
    const wire = await sent(new URLSearchParams({ a: '1', b: 'x y' }))
    expect(wire).toContain('Content-Type: application/x-www-form-urlencoded;charset=UTF-8')
    expect(wire.endsWith('\r\n\r\na=1&b=x+y')).toBe(true)
  })

  it('sends only the bytes a partial view covers', async () => {
    const parent = bytes('0123456789')
    expect((await sent(parent.subarray(2, 5))).endsWith('\r\n\r\n234')).toBe(true)
  })

  it('sends a ReadableStream body', async () => {
    const stream = new ReadableStream<Uint8Array>({ start (c) { c.enqueue(bytes('stre')); c.enqueue(bytes('amed')); c.close() } })
    const wire = await sent(stream)
    expect(wire).toContain('Content-Length: 8')
    expect(wire.endsWith('\r\n\r\nstreamed')).toBe(true)
  })
})

describe('routed fetch -- a streamed response body', () => {
  it('resolves at the head and hands over body bytes as they arrive', async () => {
    const { target, sockets } = holdingTarget()
    const pending = target.fetch!('https://api.example/x')
    await settle()
    sockets[0]!.push(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n'))
    const response = await pending
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('one')
    sockets[0]!.push(bytes('3\r\ntwo\r\n0\r\n\r\n'))
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('two')
    expect((await reader.read()).done).toBe(true)
  })

  it('frees the socket of a small response the app never reads', async () => {
    const { target, sockets } = holdingTarget()
    const pending = target.fetch!('https://api.example/x')
    await settle()
    sockets[0]!.push(OK_RESPONSE)
    await pending
    await settle()
    expect(sockets[0]!.closed).toBe(true)
  })

  it('closes the socket when the app cancels the body', async () => {
    const { target, sockets } = holdingTarget()
    const pending = target.fetch!('https://api.example/x')
    await settle()
    sockets[0]!.push(bytes('HTTP/1.1 200 OK\r\n\r\npartial'))
    const response = await pending
    await response.body!.cancel()
    expect(sockets[0]!.closed).toBe(true)
  })

  it('errors the body like a network error when the connection ends early', async () => {
    const { target, sockets } = holdingTarget()
    const pending = target.fetch!('https://api.example/x')
    await settle()
    sockets[0]!.push(bytes('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort'))
    sockets[0]!.end()
    await expect((await pending).text()).rejects.toMatchObject({ message: 'Failed to fetch' })
  })
})
