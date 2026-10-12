import { describe, expect, it } from 'vitest'
import { GatewayFailure, GatewayPool, MIN_HEDGE_DELAY_MS, RedirectRefused, askGateway, readCapped } from '../gateways.js'
import type { Fetch } from '../gateways.js'

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

const read = async (response: Response): Promise<Uint8Array> => await readCapped(response, 1_000_000)

describe('askGateway -- an abort while the body is being read', () => {
  it('is cancelled when the caller aborts mid-body, and does not cool the gateway down', async () => {
    const pool = new GatewayPool([A], 4)
    const controller = new AbortController()
    const promise = askGateway(pool, slowBodyFetch(), A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 5_000 }, read, controller.signal)
    setTimeout(() => { controller.abort(new Error('superseded by a faster attempt')) }, 20)
    const failure = await failureOf(promise)
    expect(failure.outcome.kind).toBe('cancelled')
    expect(pool.candidates()).toEqual([A])
  })

  it('is a timeout, not an outage, when the request deadline lands mid-body', async () => {
    const pool = new GatewayPool([A], 4)
    const promise = askGateway(pool, slowBodyFetch(), A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 30 }, read, new AbortController().signal)
    const failure = await failureOf(promise)
    expect(failure.outcome.kind).toBe('timeout')
    expect(pool.candidates()).toEqual([A]) // one timeout alone is not a strike
  })
})

describe('askGateway -- a redirect', () => {
  it('is a miss for that item, never a strike against the gateway', async () => {
    const pool = new GatewayPool([A], 4)
    const redirecting: Fetch = async () => { throw new RedirectRefused('answered with a redirect, which is not followed') }
    for (let i = 0; i < 4; i++) {
      const failure = await failureOf(askGateway(pool, redirecting, A, { url: `${A}/chunks/${String(i)}`, accept: 'application/octet-stream', timeoutMs: 5_000 }, read, new AbortController().signal))
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
    await askGateway(pool, quick, A, { url: `${A}/ipfs/x?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: 5_000 }, read, new AbortController().signal)
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
