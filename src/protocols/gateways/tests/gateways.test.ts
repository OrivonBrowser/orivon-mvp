import { describe, expect, it } from 'vitest'
import { GatewayFailure, GatewayPool, MIN_HEDGE_DELAY_MS, RedirectRefused, askGateway, readCapped } from '../gateways.js'
import type { Fetch } from '../gateways.js'
import { DIRECT_ROUTE } from '../../route-pace.js'
import type { RoutePace } from '../../route-pace.js'

const A = 'https://a.gateway'
const B = 'https://b.gateway'

/** Headers at once, then a body that never ends until the request's signal
 * aborts, when the stream errors: the shape undici and `net.fetch` give. */
function slowBodyFetch (): Fetch {
  return async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        init.signal.addEventListener('abort', () => { controller.error(new DOMException('aborted', 'AbortError')) }, { once: true })
      }
    })
    return new Response(body, { status: 200 })
  }
}

async function failureOf (promise: Promise<unknown>): Promise<GatewayFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GatewayFailure) return error
    throw error
  }
  throw new Error('expected a GatewayFailure')
}

const read = async (response: Response, progress: () => void): Promise<Uint8Array> => await readCapped(response, 1_000_000, progress)

/** A route whose windows are a few milliseconds, so a test waits for them. */
const quickRoute: RoutePace = { ...DIRECT_ROUTE, firstWait: () => 30, stallMs: () => 40, transferMs: () => 5_000 }

describe('askGateway -- an abort while the body is being read', () => {
  it('is cancelled when the caller aborts mid-body, and does not cool the gateway down', async () => {
    const pool = new GatewayPool([A], 4)
    const controller = new AbortController()
    const promise = askGateway(pool, slowBodyFetch(), A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 5_000, maxBytes: 1024 }, read, controller.signal)
    setTimeout(() => { controller.abort(new Error('superseded by a faster attempt')) }, 20)
    const failure = await failureOf(promise)
    expect(failure.outcome.kind).toBe('cancelled')
    expect(pool.candidates()).toEqual([A])
  })

  it('is a timeout, not an outage, when the body goes quiet for longer than the route allows', async () => {
    const pool = new GatewayPool([A], 4, Date.now, { route: quickRoute })
    const promise = askGateway(pool, slowBodyFetch(), A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 30, maxBytes: 1024 }, read, new AbortController().signal)
    const failure = await failureOf(promise)
    expect(failure.outcome.kind).toBe('timeout')
    expect(failure.message).toContain('stopped sending')
    expect(pool.candidates()).toEqual([A]) // one timeout alone is not a strike
  })

  it('is a timeout that says nothing arrived, when the first byte is later than the route allows', async () => {
    const pool = new GatewayPool([A], 4, Date.now, { route: quickRoute })
    const never: Fetch = async (_url, init) => await new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(init.signal.reason) }, { once: true }) })
    const failure = await failureOf(askGateway(pool, never, A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 30, maxBytes: 1024 }, read, new AbortController().signal))
    expect(failure.outcome.kind).toBe('timeout')
    expect(failure.message).toContain('sent nothing in time')
  })

  it('does not end a body that keeps arriving past the wait a direct connection would have given it', async () => {
    const pool = new GatewayPool([A], 4, Date.now, { route: quickRoute })
    const trickle: Fetch = async (_url, init) => {
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        async pull (controller) {
          await new Promise((resolve) => setTimeout(resolve, 15))
          if (init.signal.aborted) return controller.error(init.signal.reason)
          controller.enqueue(new Uint8Array([sent++]))
          if (sent === 12) controller.close()
        }
      })
      return new Response(body, { status: 200 })
    }
    const bytes = await askGateway(pool, trickle, A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 30, maxBytes: 1024 }, read, new AbortController().signal)
    expect(bytes.length).toBe(12) // 12 chunks over about 180 ms, against a first-byte window of 30 ms and a stall window of 40 ms
  })

  it('tells the route how long the first byte took, so its patience follows the evidence', async () => {
    const seen: number[] = []
    const route: RoutePace = { ...quickRoute, observeFirstByte: (ms) => { seen.push(ms) } }
    const pool = new GatewayPool([A], 4, Date.now, { route })
    await askGateway(pool, async () => new Response(new Uint8Array([1])), A, { url: `${A}/x`, accept: 'a/b', timeoutMs: 30, maxBytes: 1024 }, read, new AbortController().signal)
    expect(seen).toHaveLength(1)
  })
})

describe('askGateway -- a redirect', () => {
  it('is a miss for that item, never a strike against the gateway', async () => {
    const pool = new GatewayPool([A], 4)
    const redirecting: Fetch = async () => { throw new RedirectRefused('answered with a redirect, which is not followed') }
    for (let i = 0; i < 4; i++) {
      const failure = await failureOf(askGateway(pool, redirecting, A, { url: `${A}/chunks/${String(i)}`, accept: 'application/octet-stream', timeoutMs: 5_000, maxBytes: 1024 }, read, new AbortController().signal))
      expect(failure.outcome.kind).toBe('miss')
    }
    expect(pool.candidates()).toEqual([A])
  })
})

describe('GatewayPool.hedgeDelay', () => {
  it('is the longest wait until some gateway has answered', () => {
    const pool = new GatewayPool([A, B], 4)
    expect(pool.hedgeDelay(A, 2_000)).toBe(2_000)
  })

  it('is a few times what the leader typically takes, within the shortest and the longest wait', () => {
    const pool = new GatewayPool([A, B], 4)
    pool.note(A, { kind: 'ok', latencyMs: 300 })
    expect(pool.hedgeDelay(A, 2_000)).toBe(900)
    pool.note(B, { kind: 'ok', latencyMs: 10 })
    expect(pool.hedgeDelay(B, 2_000)).toBe(MIN_HEDGE_DELAY_MS)
    pool.note(A, { kind: 'ok', latencyMs: 10_000 })
    expect(pool.hedgeDelay(A, 2_000)).toBe(2_000)
  })

  it('for a leader that never answered, is what the fastest gateway typically takes', () => {
    const pool = new GatewayPool([A, B], 4)
    pool.note(B, { kind: 'ok', latencyMs: 250 })
    expect(pool.hedgeDelay(A, 2_000)).toBe(750)
  })

  it('times a success from the request leaving, so the next hedge knows it', async () => {
    const pool = new GatewayPool([A], 4)
    const quick: Fetch = async () => new Response(new Uint8Array([1]), { status: 200 })
    await askGateway(pool, quick, A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 5_000, maxBytes: 1024 }, read, new AbortController().signal)
    expect(pool.hedgeDelay(A, 2_000)).toBe(MIN_HEDGE_DELAY_MS)
  })
})

describe('GatewayPool.refuse', () => {
  it('drops a source that sent a bad answer for the rest of the session', () => {
    const pool = new GatewayPool([A, B], 4)
    pool.refuse(A)
    expect(pool.usable()).toEqual([B])
  })

  it('only sits a local node out for its quarantine, which ends', () => {
    let now = 1_000
    const pool = new GatewayPool([A], 4, () => now, { lieQuarantineMs: 30_000 })
    pool.refuse(A)
    expect(pool.usable()).toEqual([A])
    expect(pool.candidates()).toEqual([])
    now += 30_001
    expect(pool.candidates()).toEqual([A])
  })
})

describe('askGateway -- a 5xx', () => {
  const unwell: Fetch = async () => new Response('down', { status: 504 })
  const request = { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 5_000, maxBytes: 1024 }

  it('marks a gateway unwell, which cools it', async () => {
    const pool = new GatewayPool([A], 4)
    expect((await failureOf(askGateway(pool, unwell, A, request, read, new AbortController().signal))).outcome.kind).toBe('server-error')
    expect(pool.candidates()).toEqual([])
  })

  it('is a source\'s plain answer that it lacks the content, with no cooling, when the pool takes a 5xx as an answer', async () => {
    const pool = new GatewayPool([A], 4, Date.now, { serverErrorsAreAnswers: true })
    const failure = await failureOf(askGateway(pool, unwell, A, request, read, new AbortController().signal))
    expect(failure).toMatchObject({ outcome: { kind: 'miss' }, status: 504 })
    expect(pool.candidates()).toEqual([A])
  })
})
