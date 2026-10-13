import { EventEmitter } from 'node:events'
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

  it('rejects with the request\'s own error', async () => {
    const { net } = fakeNet((request) => { request.emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED')) })
    await expect(createRequestFetch({ net, answer: () => {} })('https://a.example/x')).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED/)
  })
})
