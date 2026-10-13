import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { Net, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { setRouteChallengeSource } from '../lookup-session.js'
import { fetchThroughRoute } from '../routed-fetch.js'

const SESSION = { name: 'route' } as unknown as Session

interface FakeRequest extends EventEmitter { end: () => void, abort: () => void }

function fakeNet (act: (request: FakeRequest) => void): { net: Pick<Net, 'request'>, options: unknown[] } {
  const options: unknown[] = []
  const net = {
    request: (given: unknown) => {
      options.push(given)
      const request = new EventEmitter() as FakeRequest
      request.end = () => { queueMicrotask(() => { act(request) }) }
      request.abort = () => { request.emit('error', new Error('aborted')) }
      return request
    }
  } as unknown as Pick<Net, 'request'>
  return { net, options }
}

function answer (statusCode: number, body: string, headers: Record<string, string | string[]> = {}): Readable & { statusCode: number, headers: Record<string, string | string[]> } {
  const stream = Readable.from([Buffer.from(body)]) as Readable & { statusCode: number, headers: Record<string, string | string[]> }
  stream.statusCode = statusCode
  stream.headers = headers
  return stream
}

describe('a request made by main through an app\'s route', () => {
  it('asks in the route\'s session, with no credentials or cookies of the browser, and answers as a Response', async () => {
    const { net, options } = fakeNet((request) => { request.emit('response', answer(200, '{"ok":true}', { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })) })

    const response = await fetchThroughRoute(net, SESSION, 'https://score.example/x.json', new AbortController().signal)

    expect(options).toEqual([expect.objectContaining({ url: 'https://score.example/x.json', session: SESSION, credentials: 'omit', useSessionCookies: false })])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ ok: true })
  })

  it('answers the front\'s proxy challenge itself, which the application\'s login event never sees for a request without web contents', async () => {
    setRouteChallengeSource((info) => info.port === 4040 ? { username: 'orivon', password: 'secret' } : undefined)
    const given = vi.fn()
    const { net } = fakeNet((request) => {
      request.emit('login', { isProxy: true, host: '127.0.0.1', port: 4040 }, given)
      request.emit('login', { isProxy: true, host: '127.0.0.1', port: 4041 }, given)
      request.emit('response', answer(200, 'ok'))
    })

    await fetchThroughRoute(net, SESSION, 'https://score.example/x.json', new AbortController().signal)

    expect(given.mock.calls).toEqual([['orivon', 'secret'], []])
  })

  it('rejects with the signal\'s reason when it fires, so a timeout is still a timeout', async () => {
    const { net } = fakeNet(() => {})
    const signal = AbortSignal.timeout(20)

    await expect(fetchThroughRoute(net, SESSION, 'https://score.example/x.json', signal)).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('keeps the signal over the body: a body that stalls after the headers is cut off when it fires', async () => {
    const { net } = fakeNet((request) => {
      const stalled = new Readable({ read () {} }) as Readable & { statusCode: number, headers: Record<string, string> }
      stalled.statusCode = 200
      stalled.headers = {}
      request.emit('response', stalled)
    })
    const controller = new AbortController()

    const response = await fetchThroughRoute(net, SESSION, 'https://score.example/x.json', controller.signal)
    const reading = response.text()
    controller.abort(new Error('too slow'))

    await expect(reading).rejects.toThrow()
  })

  it('rejects at once for a signal that has already fired, without ending the request', async () => {
    const { net } = fakeNet(() => { throw new Error('the request was sent') })
    const fired = new AbortController()
    fired.abort(new Error('stop'))

    await expect(fetchThroughRoute(net, SESSION, 'https://score.example/x.json', fired.signal)).rejects.toThrow('stop')
  })

  it('rejects with the request\'s own error', async () => {
    const { net } = fakeNet((request) => { request.emit('error', new Error('ERR_PROXY_CONNECTION_FAILED')) })
    await expect(fetchThroughRoute(net, SESSION, 'https://score.example/x.json', new AbortController().signal)).rejects.toThrow('ERR_PROXY_CONNECTION_FAILED')
  })
})
