import { describe, expect, it } from 'vitest'
import { GatewayFailure, GatewayPool, askGateway, readCapped } from '../gateways.js'
import type { Fetch } from '../gateways.js'

const A = 'https://a.gateway'

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
