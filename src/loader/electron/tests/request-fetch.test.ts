import { EventEmitter, getEventListeners } from 'node:events'
import { Readable } from 'node:stream'
import type { Net, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createRequestFetch } from '../request-fetch.js'

interface FakeRequest extends EventEmitter { end: () => void, abort: () => void, setHeader: (name: string, value: string) => void, write: (chunk: Buffer) => void }

function fakeNet (act: (request: FakeRequest, written: Buffer[]) => void) {
  const options: Array<Record<string, unknown>> = []
  const headers: Array<[string, string]> = []
  const written: Buffer[] = []
  const net = {
    request: (given: Record<string, unknown>) => {
      options.push(given)
      const request = new EventEmitter() as FakeRequest
      request.setHeader = (name, value) => { headers.push([name, value]) }
      request.write = (chunk) => { written.push(chunk) }
      request.end = () => { queueMicrotask(() => { act(request, written) }) }
      request.abort = () => { request.emit('error', new Error('aborted')) }
      return request
    }
  } as unknown as Pick<Net, 'request'>
  return { net, options, headers, written }
}

function answer (statusCode: number, body: string, headers: Record<string, string | string[]> = {}) {
  const stream = Readable.from([Buffer.from(body)]) as Readable & { statusCode: number, headers: Record<string, string | string[]> }
  stream.statusCode = statusCode
  stream.headers = headers
  return stream
}

describe('a fetch made with net.request', () => {
  it('signs in to the front through the login listener, with what the answer function gives for that challenge and nothing for another', async () => {
    const given = vi.fn()
    const { net } = fakeNet((request) => {
      request.emit('login', { isProxy: true, host: '127.0.0.1', port: 4040 }, given)
      request.emit('login', { isProxy: true, host: '10.0.0.1', port: 3128 }, given)
      request.emit('response', answer(200, 'ok'))
    })
    const fetch = createRequestFetch({ net, answer: (info, callback) => { if (info.port === 4040) callback('orivon', 'secret'); else callback() } })

    const response = await fetch('https://gateway.example/ipfs/x')

    expect(await response.text()).toBe('ok')
    expect(given.mock.calls).toEqual([['orivon', 'secret'], []])
  })

  it('makes the request with no credentials or cookies of the browser, in the session it is given, or in none for a utility process', async () => {
    const session = { name: 'default' } as unknown as Session
    const first = fakeNet((request) => { request.emit('response', answer(200, '{}')) })
    await createRequestFetch({ net: first.net, session, answer: () => {} })('https://a.example/x')
    expect(first.options[0]).toMatchObject({ url: 'https://a.example/x', method: 'GET', credentials: 'omit', useSessionCookies: false, session, redirect: 'follow' })

    const second = fakeNet((request) => { request.emit('response', answer(200, '{}')) })
    await createRequestFetch({ net: second.net, answer: () => {} })('https://a.example/x')
    expect(second.options[0]).not.toHaveProperty('session')
  })

  it('sends the session\'s cookies only when asked to, as the Reader\'s pictures need them', async () => {
    const { net, options } = fakeNet((request) => { request.emit('response', answer(200, '')) })
    await createRequestFetch({ net, answer: () => {}, credentials: 'include' })('https://a.example/x')
    expect(options[0]).toMatchObject({ credentials: 'include', useSessionCookies: true })
  })

  it('asks for revalidation when the caller asked for no-store, which net.request cannot say', async () => {
    const { net, headers } = fakeNet((request) => { request.emit('response', answer(200, '')) })
    await createRequestFetch({ net, answer: () => {} })('https://a.example/x', { cache: 'no-store' })
    expect(headers).toContainEqual(['Cache-Control', 'no-cache'])
  })

  it('sends the method, headers and body of a POST, less the headers the network stack sets', async () => {
    const { net, options, headers, written } = fakeNet((request) => { request.emit('response', answer(204, '')) })
    const response = await createRequestFetch({ net, answer: () => {} })('https://gw.example/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999', host: 'evil.example', 'x-extra': '1' },
      body: JSON.stringify({ data: '0x01' })
    })

    expect(options[0]).toMatchObject({ method: 'POST' })
    expect(headers).toEqual([['content-type', 'application/json'], ['x-extra', '1']])
    expect(Buffer.concat(written).toString()).toBe('{"data":"0x01"}')
    expect(response.status).toBe(204)
  })

  it('refuses a body it cannot send as bytes', async () => {
    const { net } = fakeNet(() => {})
    await expect(createRequestFetch({ net, answer: () => {} })('https://a.example/x', { method: 'POST', body: new FormData() })).rejects.toThrow(TypeError)
  })

  it('answers a redirect as a response with its location when asked not to follow, and aborts the request', async () => {
    const { net, options } = fakeNet((request) => { request.emit('redirect', 302, 'GET', 'https://other.example/next', { location: ['https://other.example/next'] }) })
    const response = await createRequestFetch({ net, answer: () => {} })('https://gw.example/x', { redirect: 'manual' })

    expect(options[0]).toMatchObject({ redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://other.example/next')
  })

  it('rejects with the signal\'s reason, also while the body is read', async () => {
    const early = fakeNet(() => {})
    await expect(createRequestFetch({ net: early.net, answer: () => {} })('https://a.example/x', { signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ name: 'TimeoutError' })

    const stalled = fakeNet((request) => {
      const body = new Readable({ read () {} }) as Readable & { statusCode: number, headers: Record<string, string> }
      body.statusCode = 200
      body.headers = {}
      request.emit('response', body)
    })
    const controller = new AbortController()
    const response = await createRequestFetch({ net: stalled.net, answer: () => {} })('https://a.example/x', { signal: controller.signal })
    const reading = response.text()
    controller.abort(new Error('too slow'))
    await expect(reading).rejects.toThrow()
  })

  it('aborts the request when its answer is let go before the end, and only then', async () => {
    const aborted = vi.fn()
    const { net } = fakeNet((request) => {
      request.abort = aborted
      request.emit('response', answer(200, 'a long page'))
    })
    const fetch = createRequestFetch({ net, answer: () => {} })

    await (await fetch('https://a.example/x')).body?.cancel()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(aborted).toHaveBeenCalledTimes(1)

    aborted.mockClear()
    expect(await (await fetch('https://a.example/y')).text()).toBe('a long page')
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(aborted).not.toHaveBeenCalled()
  })

  it('rejects with the request\'s own error', async () => {
    const { net } = fakeNet((request) => { request.emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED')) })
    await expect(createRequestFetch({ net, answer: () => {} })('https://a.example/x')).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED/)
  })
})

/** What a fetch came to by the time the event loop turned: it is `pending` when the listener left it unsettled. */
async function outcomeOf (fetched: Promise<Response>): Promise<{ readonly kind: 'resolved', readonly response: Response } | { readonly kind: 'rejected', readonly error: unknown } | { readonly kind: 'pending' }> {
  return await Promise.race([
    fetched.then((response) => ({ kind: 'resolved' as const, response }), (error: unknown) => ({ kind: 'rejected' as const, error })),
    new Promise<{ readonly kind: 'pending' }>((resolve) => { setImmediate(() => { resolve({ kind: 'pending' }) }) })
  ])
}

const NEXT = 'https://pages.example/wiki/%E6%9D%B1%E4%BA%AC'

describe('an answer that cannot be held as a Response', () => {
  /** A net whose request fires `emit` inside a try, because Electron fires its listeners outside any: what is thrown here is what would end the browser. */
  function emitting (emit: (request: FakeRequest) => void) {
    const thrown: unknown[] = []
    const aborted = vi.fn()
    const made = fakeNet((request) => {
      request.abort = aborted
      try { emit(request) } catch (error) { thrown.push(error) }
    })
    return { ...made, thrown, aborted }
  }

  it.each([
    ['a character above U+00FF', 'cost €5'],
    ['a character of the replacement kind', 'caf�.html'],
    ['characters of a script far above U+00FF', '/wiki/東京'],
    ['a line break', 'one\ntwo']
  ])('drops a header value with %s, keeps the other headers, and settles', async (_name, value) => {
    const { net, thrown } = emitting((request) => { request.emit('response', answer(200, 'the page', { 'content-type': 'text/html', 'x-note': value, 'x-kept': 'yes' })) })
    const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/'))

    expect(thrown, 'nothing left the listener').toEqual([])
    if (outcome.kind !== 'resolved') throw new Error(`the fetch ${outcome.kind}`)
    expect(outcome.response.headers.get('x-note')).toBeNull()
    expect(outcome.response.headers.get('content-type')).toBe('text/html')
    expect(outcome.response.headers.get('x-kept')).toBe('yes')
    expect(await outcome.response.text()).toBe('the page')
  })

  it('drops a header name that is not a token, and the one value of a repeated header that does not fit, and keeps the rest', async () => {
    const { net, thrown } = emitting((request) => {
      request.emit('response', answer(200, 'ok', { 'bad name': 'v', 'set-cookie': ['a=1', 'b=€', 'c=3'] }))
    })
    const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/'))

    expect(thrown).toEqual([])
    if (outcome.kind !== 'resolved') throw new Error(`the fetch ${outcome.kind}`)
    expect([...outcome.response.headers.keys()]).not.toContain('bad name')
    expect(outcome.response.headers.getSetCookie()).toEqual(['a=1', 'c=3'])
  })

  it.each([[600], [199], [999], [0], [101]])('refuses a status of %d with a TypeError, aborts the request, and leaves nothing for a later signal to destroy', async (status) => {
    const stream = answer(status, 'x', { 'content-type': 'text/html' })
    const controller = new AbortController()
    const { net, thrown, aborted } = emitting((request) => { request.emit('response', stream) })
    const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/', { signal: controller.signal }))

    expect(thrown).toEqual([])
    expect(outcome.kind).toBe('rejected')
    expect((outcome as { error: unknown }).error).toBeInstanceOf(TypeError)
    expect(aborted).toHaveBeenCalledTimes(1)
    expect(stream.destroyed).toBe(true)
    expect(stream.listenerCount('close'), 'a refused answer is given no listener before it is refused').toBe(0)
    expect(getEventListeners(controller.signal, 'abort'), 'no abort listener is left on the caller\'s signal').toHaveLength(0)

    controller.abort(new Error('the deadline'))
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(stream.errored, 'the signal destroyed nothing with an error nobody listens for').toBeNull()
  })

  it('accepts the statuses at both ends of 200 to 599', async () => {
    for (const status of [200, 599]) {
      const { net, thrown } = emitting((request) => { request.emit('response', answer(status, 'x')) })
      const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/'))
      expect(thrown).toEqual([])
      expect(outcome.kind, String(status)).toBe('resolved')
    }
  })

  it('follows a redirect whose location holds characters above U+00FF by the address the network resolved it to', async () => {
    const { net, thrown, aborted } = emitting((request) => { request.emit('redirect', 302, 'GET', NEXT, { location: '/wiki/東京', 'x-kept': 'yes' }) })
    const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/wiki/x', { redirect: 'manual' }))

    expect(thrown).toEqual([])
    if (outcome.kind !== 'resolved') throw new Error(`the fetch ${outcome.kind}`)
    expect(outcome.response.status).toBe(302)
    expect(outcome.response.headers.get('location')).toBe(NEXT)
    expect(outcome.response.headers.get('x-kept')).toBe('yes')
    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('keeps a location that fits, and takes the resolved address when every location value is dropped', async () => {
    const fits = emitting((request) => { request.emit('redirect', 301, 'GET', NEXT, { location: ['/plain/next'] }) })
    const kept = await outcomeOf(createRequestFetch({ net: fits.net, answer: () => {} })('https://pages.example/', { redirect: 'manual' }))
    if (kept.kind !== 'resolved') throw new Error(`the fetch ${kept.kind}`)
    expect(kept.response.headers.get('location')).toBe('/plain/next')

    const odd = emitting((request) => { request.emit('redirect', 301, 'GET', NEXT, { location: ['/東', '/京'] }) })
    const taken = await outcomeOf(createRequestFetch({ net: odd.net, answer: () => {} })('https://pages.example/', { redirect: 'manual' }))
    expect(odd.thrown).toEqual([])
    if (taken.kind !== 'resolved') throw new Error(`the fetch ${taken.kind}`)
    expect(taken.response.headers.get('location')).toBe(NEXT)
  })

  it('rejects, and lets nothing out of the listener, when a redirect cannot be made into a response at all', async () => {
    for (const [status, redirectUrl, headers] of [[302, 'https://pages.example/\u6771', {}], [600, NEXT, { location: '/x' }]] as const) {
      const { net, thrown, aborted } = emitting((request) => { request.emit('redirect', status, 'GET', redirectUrl, headers) })
      const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/', { redirect: 'manual' }))
      expect(thrown, String(status)).toEqual([])
      expect(outcome.kind, String(status)).toBe('rejected')
      expect((outcome as { error: unknown }).error).toBeInstanceOf(TypeError)
      expect(aborted).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves no abort listener on the signal after a redirect, a refusal or an answer, so a signal fired later throws nothing', async () => {
    for (const emit of [
      (request: FakeRequest) => { request.emit('redirect', 302, 'GET', NEXT, { location: '/東' }) },
      (request: FakeRequest) => { request.emit('response', answer(600, 'x')) }
    ]) {
      const controller = new AbortController()
      const { net, thrown } = emitting(emit)
      await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/', { redirect: 'manual', signal: controller.signal }))
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(() => { controller.abort(new Error('late')) }).not.toThrow()
      expect(thrown).toEqual([])
    }

    const controller = new AbortController()
    const { net } = emitting((request) => { request.emit('response', answer(200, 'whole page', { 'x-note': '€' })) })
    const outcome = await outcomeOf(createRequestFetch({ net, answer: () => {} })('https://pages.example/', { signal: controller.signal }))
    if (outcome.kind !== 'resolved') throw new Error(`the fetch ${outcome.kind}`)
    expect(await outcome.response.text()).toBe('whole page')
    expect(() => { controller.abort(new Error('late')) }).not.toThrow()
  })

  it('rejects when the function that answers a proxy\'s challenge throws, and lets nothing out of the listener', async () => {
    const { net, thrown, aborted } = emitting((request) => { request.emit('login', { isProxy: true, host: '127.0.0.1', port: 4040 }, vi.fn()) })
    const outcome = await outcomeOf(createRequestFetch({ net, answer: () => { throw new Error('no front') } })('https://pages.example/'))

    expect(thrown).toEqual([])
    expect(outcome.kind).toBe('rejected')
    expect((outcome as { error: unknown }).error).toBeInstanceOf(TypeError)
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})
