import { describe, expect, it } from 'vitest'
import type { WebFetch } from '../../egress.js'
import { failoverRpc, problemOf } from '../rpc-failover.js'

const A = 'https://a.rpc'
const B = 'https://b.rpc'
const C = 'https://c.rpc'
const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getProof', params: [] })

function endpoints (answers: Record<string, () => Response>): { fetch: (url: string, init?: RequestInit) => Promise<Response>, asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetch: async (url, init) => {
      asked.push(`${url} ${String(init?.body)}`)
      const answer = answers[url]
      if (answer === undefined) throw new Error(`connect ECONNREFUSED ${url}`)
      return answer()
    }
  }
}

const ok = (): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))
const proofWindow = (): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'distance to target block exceeds maximum proof window' } }))

describe('failoverRpc', () => {
  it('uses the first endpoint that answers without an error, sending it the same body', async () => {
    const e = endpoints({ [A]: proofWindow, [B]: ok })
    const response = await failoverRpc([A, B], e.fetch)(A, { method: 'POST', body: BODY })
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' })
    expect(e.asked).toEqual([`${A} ${BODY}`, `${B} ${BODY}`])
  })

  it('moves on from an HTTP failure and from a refused connection', async () => {
    expect(await (await failoverRpc([A, B], endpoints({ [A]: () => new Response('busy', { status: 503 }), [B]: ok }).fetch)(A, { method: 'POST', body: BODY })).json()).toMatchObject({ result: '0x1' })
    expect(await (await failoverRpc([A, B], endpoints({ [B]: ok }).fetch)(A, { method: 'POST', body: BODY })).json()).toMatchObject({ result: '0x1' })
  })

  it("returns the last endpoint's error when every one fails, for the light client to report", async () => {
    const response = await failoverRpc([A, B], endpoints({ [A]: proofWindow, [B]: proofWindow }).fetch)(A, { method: 'POST', body: BODY })
    expect(await response.json()).toMatchObject({ error: { code: -32602 } })
  })

  it('treats one error inside a batch as a failed answer', async () => {
    const batch = (): Response => new Response(JSON.stringify([{ id: 1, result: '0x1' }, { id: 2, error: { code: -32001 } }]))
    const response = await failoverRpc([A, B], endpoints({ [A]: batch, [B]: ok }).fetch)(A, { method: 'POST', body: BODY })
    expect(await response.json()).toMatchObject({ result: '0x1' })
  })

  it('answers as the endpoint the light client asked, with the transport headers gone', async () => {
    const compressed = (): Response => new Response(JSON.stringify({ result: '0x1' }), { headers: { 'content-encoding': 'br', 'content-type': 'application/json' } })
    const response = await failoverRpc([A, B], endpoints({ [A]: proofWindow, [B]: compressed }).fetch)(A, { method: 'POST', body: BODY })
    expect(response.url).toBe(A)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('throws when no endpoint could be reached at all', async () => {
    await expect(failoverRpc([A, B], endpoints({}).fetch)(A, { method: 'POST', body: BODY })).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('failoverRpc -- which server failed, and why', () => {
  const record = (): { problems: Map<string, string | undefined>, note: (endpoint: string, problem: string | undefined) => void } => {
    const problems = new Map<string, string | undefined>()
    return { problems, note: (endpoint, problem) => { problems.set(endpoint, problem) } }
  }

  it('records the status an endpoint answered, never its address, and forgets it once the endpoint answers', async () => {
    const { problems, note } = record()
    const busy = (): Response => new Response('busy', { status: 429 })
    await failoverRpc([A, B], endpoints({ [A]: busy, [B]: ok }).fetch, note)(A, { method: 'POST', body: BODY })
    expect(problems.get(A)).toBe('answered 429')
    expect(problems.get(B)).toBeUndefined()
    await failoverRpc([A, B], endpoints({ [A]: ok, [B]: ok }).fetch, note)(A, { method: 'POST', body: BODY })
    expect(problems.get(A)).toBeUndefined()
  })

  it('records an error answer by its code, an unreadable one, and a refused connection by its code', async () => {
    const { problems, note } = record()
    const garbage = (): Response => new Response('<html>nope</html>')
    const refused = async (): Promise<Response> => { throw Object.assign(new Error(`connect ECONNREFUSED ${A}/v3/SECRET`), { code: 'ECONNREFUSED' }) }
    await failoverRpc([A, B], (async (url: string) => url === A ? await refused() : proofWindow()) as never, note)(A, { method: 'POST', body: BODY })
    expect(problems.get(A)).toBe('could not be reached (ECONNREFUSED)')
    expect(problems.get(B)).toBe('answered a JSON-RPC error (code -32602)')
    await failoverRpc([A], endpoints({ [A]: garbage }).fetch, note)(A, { method: 'POST', body: BODY })
    expect(problems.get(A)).toBe('answered something that is not JSON-RPC')
  })

  it('never carries text the server or the connection gave', async () => {
    const { problems, note } = record()
    const hostile = (): Response => new Response(JSON.stringify({ error: { code: -32000, message: 'invalid key SECRET-KEY-VALUE' } }))
    await failoverRpc([A], endpoints({ [A]: hostile }).fetch, note)(A, { method: 'POST', body: BODY })
    await failoverRpc([B], (async () => { throw new Error('fetch failed for https://b.rpc/v3/SECRET-KEY-VALUE') }) as never, note)(B, { method: 'POST', body: BODY }).catch(() => {})
    expect([...problems.values()].join(' ')).not.toContain('SECRET')
  })
})

describe('failoverRpc -- a server that is slow or hangs', () => {
  /** Small waits, so the tests run on real timers: the second server is asked after 20 ms, and a server is given up on after 200 ms. */
  const TIMING = { hedgeAfterMs: 20, attemptTimeoutMs: 200 }
  const request = { method: 'POST', body: BODY }
  const noAnswer = 'did not answer in time'

  /** A fetch that never answers and rejects as a real one does once its signal aborts. */
  const hangs = async (signal: AbortSignal | null | undefined): Promise<Response> => await new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
  const answersAfter = (ms: number, result: string) => async (): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  }
  const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 5)) }

  function servers (answers: Record<string, (signal: AbortSignal | null | undefined) => Promise<Response>>): { fetch: WebFetch, asked: string[], signals: Map<string, AbortSignal>, problems: Map<string, string | undefined>, note: (endpoint: string, problem: string | undefined) => void } {
    const asked: string[] = []
    const signals = new Map<string, AbortSignal>()
    const problems = new Map<string, string | undefined>()
    return {
      asked,
      signals,
      problems,
      note: (endpoint, problem) => { problems.set(endpoint, problem) },
      fetch: async (url, init) => {
        asked.push(url)
        if (init?.signal != null) signals.set(url, init.signal)
        return await answers[url]!(init?.signal)
      }
    }
  }

  it('asks the next server when the first has not answered in time, returns its answer, and gives up on the one that hung', async () => {
    const s = servers({ [A]: hangs, [B]: async () => ok() })
    const started = Date.now()
    const response = await failoverRpc([A, B], s.fetch, s.note, TIMING)(A, request)
    expect(await response.json()).toMatchObject({ result: '0x1' })
    expect(Date.now() - started).toBeLessThan(TIMING.attemptTimeoutMs)
    expect(s.asked).toEqual([A, B])
    await tick()
    expect(s.signals.get(A)?.aborted).toBe(true)
    expect(s.problems.get(A)).toBe(noAnswer)
    expect(s.problems.get(B)).toBeUndefined()
  })

  it('lets a slow first server answer before the hedged one, and cancels the hedge without calling it a problem', async () => {
    const s = servers({ [A]: answersAfter(60, '0xa'), [B]: hangs })
    const response = await failoverRpc([A, B], s.fetch, s.note, TIMING)(A, request)
    expect(await response.json()).toMatchObject({ result: '0xa' })
    expect(s.asked).toEqual([A, B])
    await tick()
    expect(s.signals.get(B)?.aborted).toBe(true)
    expect(s.problems.has(B)).toBe(false)
    expect(s.problems.get(A)).toBeUndefined()
  })

  it('frees room for the third server when two have hung, and says so of both', async () => {
    const s = servers({ [A]: hangs, [B]: hangs, [C]: async () => ok() })
    const response = await failoverRpc([A, B, C], s.fetch, s.note, TIMING)(A, request)
    expect(await response.json()).toMatchObject({ result: '0x1' })
    expect(s.asked).toEqual([A, B, C])
    await tick()
    expect(s.problems.get(A)).toBe(noAnswer)
    expect(s.problems.get(B)).toBe(noAnswer)
  })

  it('passes over a server that fails at once without waiting for the hedge', async () => {
    const s = servers({ [A]: async () => new Response('busy', { status: 503 }), [B]: async () => ok() })
    const started = Date.now()
    await failoverRpc([A, B], s.fetch, s.note, { hedgeAfterMs: 5_000, attemptTimeoutMs: 10_000 })(A, request)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(s.problems.get(A)).toBe('answered 503')
  })

  it('throws a timeout that reads as not answering in time when every server hangs', async () => {
    const s = servers({ [A]: hangs, [B]: hangs })
    const error = await failoverRpc([A, B], s.fetch, s.note, TIMING)(A, request).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Error)
    expect(problemOf(error)).toBe(noAnswer)
    expect((error as Error).message).not.toContain('rpc')
    expect(s.problems.get(A)).toBe(noAnswer)
    expect(s.problems.get(B)).toBe(noAnswer)
  })

  it('gives up on a lone server that hangs, and on one that sends its headers and then stalls the body', async () => {
    const stalled = async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({ start () {} }))
    for (const answer of [hangs, stalled]) {
      const s = servers({ [A]: answer })
      const error = await failoverRpc([A], s.fetch, s.note, { hedgeAfterMs: 20, attemptTimeoutMs: 80 })(A, request).then(() => undefined, (thrown: unknown) => thrown)
      expect(problemOf(error)).toBe(noAnswer)
      expect(s.problems.get(A)).toBe(noAnswer)
    }
  })

  it('moves on from servers whose fetch ignores the abort', async () => {
    const ignores = async (): Promise<Response> => await new Promise<Response>(() => {})
    const s = servers({ [A]: ignores, [B]: ignores, [C]: async () => ok() })
    const response = await failoverRpc([A, B, C], s.fetch, s.note, TIMING)(A, request)
    expect(await response.json()).toMatchObject({ result: '0x1' })
  })

  it('stops at once when the light client cancels the request, and calls no server at fault', async () => {
    const s = servers({ [A]: hangs, [B]: hangs })
    const cancel = new AbortController()
    setTimeout(() => { cancel.abort(new Error('cancelled by the light client')) }, 40)
    const started = Date.now()
    await expect(failoverRpc([A, B], s.fetch, s.note, TIMING)(A, { ...request, signal: cancel.signal })).rejects.toThrow('cancelled by the light client')
    expect(Date.now() - started).toBeLessThan(TIMING.attemptTimeoutMs)
    await tick()
    expect(s.signals.get(A)?.aborted).toBe(true)
    expect(s.signals.get(B)?.aborted).toBe(true)
    expect(s.problems.size).toBe(0)
  })
})

describe('problemOf', () => {
  it('reads a code or a name from an error, and nothing else of it', () => {
    expect(problemOf(Object.assign(new Error('x https://k.example/SECRET'), { code: 'ECONNRESET' }))).toBe('could not be reached (ECONNRESET)')
    expect(problemOf(Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), { code: 'ERR_NAME_NOT_RESOLVED' }))).toBe('could not be reached (ERR_NAME_NOT_RESOLVED)')
    expect(problemOf(new DOMException('timed out', 'TimeoutError'))).toBe('did not answer in time')
    expect(problemOf(new Error('local fetch to 127.0.0.1 carried no bytes for 30000 ms'))).toBe('did not answer in time')
    expect(problemOf(new Error('something SECRET'))).toBe('could not be reached')
    expect(problemOf('SECRET')).toBe('could not be reached')
  })
})

