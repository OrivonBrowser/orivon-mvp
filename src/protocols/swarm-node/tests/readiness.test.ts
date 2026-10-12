import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FromNode } from '../protocol.js'
import { peerCountOf, peerCountOfLog, pollPeers, watchReadiness } from '../readiness.js'
import type { Fetcher } from '../readiness.js'

afterEach(() => { vi.useRealTimers() })

const answer = (body: unknown, ok = true): Awaited<ReturnType<Fetcher>> => ({ ok, json: async () => body })

describe('peerCountOf', () => {
  it.each([
    [{ peers: [{}, {}, {}] }, 3], [{ peers: [] }, 0], [{ connected: 12, population: 99 }, 12], [{ connected: 0 }, 0],
    [{ connected: -1 }, undefined], [{ connected: '12' }, undefined], [{ connected: 1.5 }, undefined], [{}, undefined], [null, undefined], ['text', undefined], [[], undefined]
  ])('reads %j as %s', (body, expected) => {
    expect(peerCountOf(body)).toBe(expected)
  })
})

describe('peerCountOfLog', () => {
  it('reads the count the node logs', () => {
    expect(peerCountOfLog('2026-10-12T12:00:00Z INFO ant_p2p: peers changed peer_set_size=17 added=1')).toBe(17)
    expect(peerCountOfLog('nothing here')).toBeUndefined()
  })
})

describe('pollPeers', () => {
  it('reads /peers, then falls back to /topology', async () => {
    const fetcher: Fetcher = async (url) => url.endsWith('/peers') ? answer({ nope: true }) : answer({ connected: 9 })
    expect(await pollPeers('http://127.0.0.1:1', fetcher)).toEqual({ answered: true, peers: 9 })
  })

  it('says the API did not answer when every request fails', async () => {
    const fetcher: Fetcher = async () => { throw new Error('ECONNREFUSED') }
    expect(await pollPeers('http://127.0.0.1:1', fetcher)).toEqual({ answered: false, peers: undefined })
  })

  it('says it answered with no count when the body has none, and survives a body that is not JSON', async () => {
    const fetcher: Fetcher = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad') } })
    expect(await pollPeers('http://127.0.0.1:1', fetcher)).toEqual({ answered: true, peers: undefined })
    expect(await pollPeers('http://127.0.0.1:1', async () => answer({}, false))).toEqual({ answered: true, peers: undefined })
  })
})

describe('watchReadiness', () => {
  async function run (counts: Array<number | 'down' | 'nocount'>, logPeers: () => number | undefined = () => undefined): Promise<FromNode[]> {
    vi.useFakeTimers()
    const posted: FromNode[] = []
    const queue = [...counts]
    const fetcher: Fetcher = async (url) => {
      const next = queue[0] ?? counts[counts.length - 1]
      if (next === 'down') throw new Error('refused')
      if (url.endsWith('/peers')) {
        queue.shift()
        return answer(next === 'nocount' ? {} : { peers: new Array<object>(next as number).fill({}) })
      }
      return answer({})
    }
    const stop = watchReadiness({ base: 'http://127.0.0.1:1', fetcher, post: (message) => posted.push(message), logPeers, everyMs: 1000 })
    await vi.advanceTimersByTimeAsync(counts.length * 1000 + 500)
    stop()
    return posted
  }

  it('reports listening once, each new count, and ready once at eight', async () => {
    const posted = await run([0, 3, 3, 8, 12, 12])
    expect(posted).toEqual([
      { type: 'listening' }, { type: 'peers', count: 0 }, { type: 'peers', count: 3 }, { type: 'peers', count: 8 }, { type: 'ready', peers: 8 }, { type: 'peers', count: 12 }
    ])
  })

  it('is not ready at seven', async () => {
    expect((await run([7, 7])).some((message) => message.type === 'ready')).toBe(false)
  })

  it('says nothing while the API is down', async () => {
    expect(await run(['down', 'down'])).toEqual([])
  })

  it('takes the count from the log when the API has none', async () => {
    const posted = await run(['nocount', 'nocount'], () => 9)
    expect(posted).toEqual([{ type: 'listening' }, { type: 'peers', count: 9 }, { type: 'ready', peers: 9 }])
  })

  it('stops posting when stopped', async () => {
    vi.useFakeTimers()
    const posted: FromNode[] = []
    const stop = watchReadiness({ base: 'http://127.0.0.1:1', fetcher: async () => answer({ peers: [] }), post: (message) => posted.push(message), logPeers: () => undefined, everyMs: 1000 })
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(posted).toEqual([])
  })
})
