import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebFetch } from '../../egress.js'
import { failoverRpc, problemOf } from '../rpc-failover.js'

const A = 'https://a.rpc'
const B = 'https://b.rpc'
const C = 'https://c.rpc'
const D = 'https://d.rpc'
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

/** Real timers and small waits: the second server is asked after 20 ms, and the tests that wait for a give-up use a limit of 100 ms. A test that expects an answer before any give-up uses a limit of seconds, so a slow machine cannot reach it. */
const HEDGED = { hedgeAfterMs: 20, attemptTimeoutMs: 5_000 }
const GIVES_UP = { hedgeAfterMs: 20, attemptTimeoutMs: 100 }
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
/** Sends its headers and then never the body. */
const stalled = async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({ start () {} }))
const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 5)) }
const result = async (response: Response): Promise<unknown> => ((await response.json()) as { result?: unknown }).result

type Answer = (signal: AbortSignal | null | undefined) => Promise<Response>

function servers (answers: Record<string, Answer>): { fetch: WebFetch, asked: string[], signals: Map<string, AbortSignal>, problems: Map<string, string | undefined>, note: (endpoint: string, problem: string | undefined) => void, cooled: Array<[string, string, number]>, onCooling: (endpoint: string, why: string, forMs: number) => void } {
  const asked: string[] = []
  const signals = new Map<string, AbortSignal>()
  const problems = new Map<string, string | undefined>()
  const cooled: Array<[string, string, number]> = []
  return {
    asked,
    signals,
    problems,
    cooled,
    note: (endpoint, problem) => { problems.set(endpoint, problem) },
    onCooling: (endpoint, why, forMs) => { cooled.push([endpoint, why, forMs]) },
    fetch: async (url, init) => {
      asked.push(url)
      if (init?.signal != null) signals.set(url, init.signal)
      return await answers[url]!(init?.signal)
    }
  }
}

describe('failoverRpc -- a server that is slow or hangs', () => {
  it('asks the next server when the first has not answered in time, returns its answer, and notes the one that said nothing', async () => {
    const s = servers({ [A]: hangs, [B]: async () => ok() })
    const started = Date.now()
    const response = await failoverRpc([A, B], s.fetch, s.note, HEDGED)(A, request)
    expect(await result(response)).toBe('0x1')
    expect(Date.now() - started).toBeLessThan(HEDGED.attemptTimeoutMs)
    expect(s.asked).toEqual([A, B])
    await tick()
    expect(s.signals.get(A)?.aborted).toBe(true)
    expect(s.problems.get(A)).toBe(noAnswer)
    expect(s.problems.get(B)).toBeUndefined()
  })

  it('lets a slow first server answer before the hedged one, and cancels the hedge without calling it a problem', async () => {
    const s = servers({ [A]: answersAfter(60, '0xa'), [B]: hangs })
    const response = await failoverRpc([A, B], s.fetch, s.note, HEDGED)(A, request)
    expect(await result(response)).toBe('0xa')
    expect(s.asked).toEqual([A, B])
    await tick()
    expect(s.signals.get(B)?.aborted).toBe(true)
    expect(s.problems.has(B)).toBe(false)
    expect(s.problems.get(A)).toBeUndefined()
  })

  it('gives up on a server that hangs when a third is left to ask, and says so of both that hung', async () => {
    const s = servers({ [A]: hangs, [B]: hangs, [C]: async () => ok() })
    const response = await failoverRpc([A, B, C], s.fetch, s.note, GIVES_UP)(A, request)
    expect(await result(response)).toBe('0x1')
    expect(s.asked).toEqual([A, B, C])
    await tick()
    expect(s.problems.get(A)).toBe(noAnswer)
    expect(s.problems.get(B)).toBe(noAnswer)
  })

  it('gives up on a server that sent its headers and stalled the body, when another is left to ask', async () => {
    const s = servers({ [A]: stalled, [B]: hangs, [C]: async () => ok() })
    const response = await failoverRpc([A, B, C], s.fetch, s.note, GIVES_UP)(A, request)
    expect(await result(response)).toBe('0x1')
    expect(s.asked).toEqual([A, B, C])
    await tick()
    expect(s.problems.get(A)).toBe(noAnswer)
  })

  it('returns the answer of a lone server that comes after the time it is given', async () => {
    let abortedWhenAnswering: boolean | undefined
    const late = async (signal: AbortSignal | null | undefined): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      abortedWhenAnswering = signal?.aborted
      return ok()
    }
    const s = servers({ [A]: late })
    const response = await failoverRpc([A], s.fetch, s.note, { hedgeAfterMs: 20, attemptTimeoutMs: 60 })(A, request)
    expect(await result(response)).toBe('0x1')
    expect(abortedWhenAnswering).toBe(false)
    expect(s.problems.get(A)).toBeUndefined()
  })

  it('returns an answer when the two servers it asked both come after the time they are given', async () => {
    const aborted: Record<string, boolean | undefined> = {}
    const late = (name: string, ms: number, answer: string) => async (signal: AbortSignal | null | undefined): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      aborted[name] = signal?.aborted
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: answer }))
    }
    const s = servers({ [A]: late('a', 300, '0xa'), [B]: late('b', 100, '0xb') })
    const response = await failoverRpc([A, B], s.fetch, s.note, { hedgeAfterMs: 20, attemptTimeoutMs: 60 })(A, request)
    expect(await result(response)).toBe('0xb')
    expect(s.asked).toEqual([A, B])
    expect(aborted.b).toBe(false)
  })

  it('waits on the last servers asked for as long as the light client does, and calls no server at fault when it cancels', async () => {
    const s = servers({ [A]: hangs, [B]: hangs })
    const cancel = new AbortController()
    const failover = failoverRpc([A, B], s.fetch, s.note, GIVES_UP)(A, { ...request, signal: cancel.signal })
    const outcome = failover.then(() => undefined, (thrown: unknown) => thrown)
    await new Promise((resolve) => setTimeout(resolve, 3 * GIVES_UP.attemptTimeoutMs))
    expect(s.signals.get(A)?.aborted).toBe(false)
    expect(s.signals.get(B)?.aborted).toBe(false)
    cancel.abort(new Error('cancelled by the light client'))
    expect((await outcome as Error).message).toBe('cancelled by the light client')
    await tick()
    expect(s.signals.get(A)?.aborted).toBe(true)
    expect(s.signals.get(B)?.aborted).toBe(true)
    expect(s.problems.size).toBe(0)
  })

  it('passes over a server that fails at once without waiting for the hedge', async () => {
    const s = servers({ [A]: async () => new Response('busy', { status: 503 }), [B]: async () => ok() })
    const started = Date.now()
    await failoverRpc([A, B], s.fetch, s.note, { hedgeAfterMs: 10_000, attemptTimeoutMs: 20_000 })(A, request)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(s.problems.get(A)).toBe('answered 503')
  })

  it('moves on from servers whose fetch ignores the abort, and lets go of the answer such a fetch delivers late', async () => {
    let cancelled = false
    let deliver: () => void = () => {}
    const late = new Response(new ReadableStream<Uint8Array>({ start () {}, cancel () { cancelled = true } }))
    const ignores = async (): Promise<Response> => await new Promise<Response>(() => {})
    const ignoresThenDelivers = async (): Promise<Response> => await new Promise<Response>((resolve) => { deliver = () => { resolve(late) } })
    const s = servers({ [A]: ignoresThenDelivers, [B]: ignores, [C]: async () => ok() })
    const response = await failoverRpc([A, B, C], s.fetch, s.note, GIVES_UP)(A, request)
    expect(await result(response)).toBe('0x1')
    expect(s.problems.get(A)).toBe(noAnswer)
    expect(cancelled).toBe(false)
    deliver()
    await tick()
    expect(cancelled).toBe(true)
  })
})

describe('failoverRpc -- servers that failed are asked last', () => {
  const busy = (retryAfter = '60') => async (): Promise<Response> => new Response('busy', { status: 429, headers: { 'retry-after': retryAfter } })
  const refused = async (): Promise<Response> => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
  const down = async (): Promise<Response> => new Response('down', { status: 503 })
  const proofWindowAnswer = async (): Promise<Response> => proofWindow()
  const okAnswer = async (): Promise<Response> => ok()

  it('asks a server that hung after the others on the next request, and says so once, not on every request', async () => {
    const s = servers({ [A]: hangs, [B]: answersAfter(60, '0xb') })
    const failover = failoverRpc([A, B], s.fetch, s.note, HEDGED, s.onCooling)
    await failover(A, request)
    await tick()
    expect(s.cooled).toEqual([])
    await failover(A, request)
    await tick()
    expect(s.cooled).toHaveLength(1)
    expect(s.cooled[0]?.slice(0, 2)).toEqual([A, noAnswer])
    expect(s.cooled[0]?.[2]).toBeGreaterThan(1_900)
    expect(s.cooled[0]?.[2]).toBeLessThanOrEqual(2_000)
    s.asked.length = 0
    expect(await result(await failover(A, request))).toBe('0xb')
    expect(s.asked).toEqual([B, A])
    await failover(A, request)
    await tick()
    expect(s.cooled).toHaveLength(1)
  })

  it('does not set a server aside for answering with a JSON-RPC error, which is what a short proof window does', async () => {
    const s = servers({ [A]: proofWindowAnswer, [B]: okAnswer })
    const failover = failoverRpc([A, B], s.fetch, s.note, HEDGED, s.onCooling)
    for (let round = 0; round < 3; round++) {
      s.asked.length = 0
      await failover(A, request)
      expect(s.asked).toEqual([A, B])
    }
    expect(s.cooled).toEqual([])
  })

  it('neither notes nor sets aside a server that was outrun after it began to answer', async () => {
    const s = servers({ [A]: stalled, [B]: answersAfter(60, '0xb') })
    const failover = failoverRpc([A, B], s.fetch, s.note, HEDGED, s.onCooling)
    for (let round = 0; round < 3; round++) {
      s.asked.length = 0
      expect(await result(await failover(A, request))).toBe('0xb')
      expect(s.asked).toEqual([A, B])
      await tick()
      expect(s.signals.get(A)?.aborted).toBe(true)
    }
    expect(s.problems.has(A)).toBe(false)
    expect(s.cooled).toEqual([])
  })

  it('sets a server aside for as long as it asked when it rate limits, briefly for server errors, and for a connection it could not make', async () => {
    const s = servers({ [A]: busy('5'), [B]: down, [C]: refused, [D]: okAnswer })
    expect(await result(await failoverRpc([A, B, C, D], s.fetch, s.note, HEDGED, s.onCooling)(A, request))).toBe('0x1')
    expect(s.cooled.map(([endpoint, why]) => [endpoint, why])).toEqual([[A, 'was rate limited'], [B, 'answered with server errors'], [C, 'could not be reached']])
    const forMs = s.cooled.map(([, , ms]) => ms)
    expect(forMs[0]).toBeGreaterThan(4_900)
    expect(forMs[0]).toBeLessThanOrEqual(5_000)
    expect(forMs[1]).toBeLessThanOrEqual(500)
    expect(forMs[2]).toBeLessThanOrEqual(2_000)
  })

  it('asks the servers that are not set aside first and the others after them, each in the order given', async () => {
    const s = servers({ [A]: busy(), [B]: busy(), [C]: answersAfter(100, '0xc') })
    const failover = failoverRpc([A, B, C], s.fetch, s.note, HEDGED, s.onCooling)
    expect(await result(await failover(A, request))).toBe('0xc')
    expect(s.asked).toEqual([A, B, C])
    s.asked.length = 0
    expect(await result(await failover(A, request))).toBe('0xc')
    expect(s.asked).toEqual([C, A, B])
  })

  it('still asks every server, in the order given, when all are set aside', async () => {
    let recovered = false
    const s = servers({ [A]: busy(), [B]: async () => recovered ? ok() : await busy()() })
    const failover = failoverRpc([A, B], s.fetch, s.note, HEDGED, s.onCooling)
    expect((await failover(A, request)).status).toBe(429)
    expect(s.cooled.map(([endpoint]) => endpoint)).toEqual([A, B])
    s.asked.length = 0
    recovered = true
    expect(await result(await failover(A, request))).toBe('0x1')
    expect(s.asked).toEqual([A, B])
  })

  describe('as time passes', () => {
    afterEach(() => { vi.useRealTimers() })

    it('asks a server first again once its cooldown has ended', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      let up = false
      const s = servers({ [A]: async () => up ? ok() : await down(), [B]: async () => ok() })
      const failover = failoverRpc([A, B], s.fetch, s.note, HEDGED, s.onCooling)
      await failover(A, request)
      s.asked.length = 0
      await failover(A, request)
      expect(s.asked).toEqual([B])
      up = true
      vi.setSystemTime(Date.now() + 600)
      s.asked.length = 0
      await failover(A, request)
      expect(s.asked).toEqual([A])
    })
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

