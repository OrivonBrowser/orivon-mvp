import { describe, expect, it } from 'vitest'
import { failoverRpc, problemOf } from '../rpc-failover.js'

const A = 'https://a.rpc'
const B = 'https://b.rpc'
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

