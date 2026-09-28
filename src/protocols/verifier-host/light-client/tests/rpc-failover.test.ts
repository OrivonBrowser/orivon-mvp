import { describe, expect, it } from 'vitest'
import { failoverRpc } from '../rpc-failover.js'

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
