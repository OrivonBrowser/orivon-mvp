// netFetchJson: an app's lookup leaves through its route's session by a request that answers the front's challenge, and
// everything else leaves the ordinary way.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { Session } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn(), request: vi.fn() } }))

const { net } = await import('electron')
const { netFetchJson } = await import('../score-provider-client.js')
const { setLookupSessionSource } = await import('../../route/lookup-session.js')

const ROUTE = { name: 'route' } as unknown as Session
const APP = 'https://app.example'

function respondWith (statusCode: number, body: string): void {
  vi.mocked(net.request).mockImplementationOnce((() => {
    const request = new EventEmitter() as EventEmitter & { end: () => void, abort: () => void }
    request.abort = () => {}
    request.end = () => {
      queueMicrotask(() => {
        const answer = Readable.from([Buffer.from(body)]) as Readable & { statusCode: number, headers: Record<string, string> }
        answer.statusCode = statusCode
        answer.headers = { 'content-type': 'application/json' }
        request.emit('response', answer)
      })
    }
    return request
  }) as never)
}

beforeEach(() => {
  vi.mocked(net.fetch).mockReset()
  vi.mocked(net.request).mockReset()
  setLookupSessionSource(async (origin) => origin === APP ? ROUTE : undefined)
})

describe('netFetchJson', () => {
  it('asks a routed app\'s provider in the route\'s session, by a request that can answer the front, never by the default fetch', async () => {
    respondWith(200, '{"standard":"x"}')

    const answer = await netFetchJson('http://provider.example/score/provider.json', APP)

    expect(answer).toEqual({ kind: 'ok', body: { standard: 'x' } })
    expect(vi.mocked(net.request).mock.calls[0]?.[0]).toMatchObject({ url: 'http://provider.example/score/provider.json', session: ROUTE })
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('reads a missing file and a refusal from the route as such', async () => {
    respondWith(404, '')
    respondWith(502, '')
    expect(await netFetchJson('http://provider.example/a.json', APP)).toEqual({ kind: 'missing' })
    expect(await netFetchJson('http://provider.example/b.json', APP)).toMatchObject({ kind: 'failed' })
  })

  it('does not leave at all when the route cannot be had', async () => {
    setLookupSessionSource(async () => { throw new Error('no route') })

    expect(await netFetchJson('http://provider.example/a.json', APP)).toMatchObject({ kind: 'failed' })

    expect(net.request).not.toHaveBeenCalled()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('goes the ordinary way for a lookup that is not about a routed app', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response('{"a":1}', { status: 200 }))

    expect(await netFetchJson('http://provider.example/a.json', 'https://other.example')).toEqual({ kind: 'ok', body: { a: 1 } })

    expect(net.request).not.toHaveBeenCalled()
  })
})
