import { describe, expect, it } from 'vitest'
import { checkMainnet, wrongChainText } from '../chain-check.js'

const A = 'https://a.rpc/v3/FAKE-KEY-0123456789'
const B = 'http://127.0.0.1:8545'
const chain = (id: string) => async (): Promise<Response> => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }))

function world (answers: Record<string, () => Promise<Response>>): { fetch: (url: string, init?: RequestInit) => Promise<Response>, asked: Array<{ url: string, body: string }> } {
  const asked: Array<{ url: string, body: string }> = []
  return {
    asked,
    fetch: async (url, init) => {
      asked.push({ url, body: String(init?.body) })
      const answer = answers[url]
      if (answer === undefined) throw new Error('no route')
      return await answer()
    }
  }
}

describe('checkMainnet', () => {
  it('asks each server for its chain id and keeps those that say mainnet', async () => {
    const w = world({ [A]: chain('0x1'), [B]: chain('0x01') })
    const result = await checkMainnet([A, B], w.fetch)
    expect(result).toEqual({ usable: [A, B], wrong: [] })
    expect(w.asked.map((entry) => entry.url).sort()).toEqual([A, B].sort())
    expect(JSON.parse(w.asked[0]?.body ?? '')).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
  })

  it('drops a server that answers another chain, and says which chain', async () => {
    const result = await checkMainnet([A, B], world({ [A]: chain('0xaa36a7'), [B]: chain('0x1') }).fetch)
    expect(result.usable).toEqual([B])
    expect(result.wrong).toEqual([{ endpoint: A, chainId: 11155111n }])
  })

  it('keeps a server it could not ask, or that answered no chain: its own problem is shown when it is used', async () => {
    const down = async (): Promise<Response> => { throw new Error('connect ECONNREFUSED') }
    const unauthorized = async (): Promise<Response> => new Response('no', { status: 401 })
    const html = async (): Promise<Response> => new Response('<html></html>')
    const noResult = async (): Promise<Response> => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }))
    const notHex = async (): Promise<Response> => new Response(JSON.stringify({ result: 'mainnet' }))
    const c = 'https://c.rpc'
    const d = 'https://d.rpc'
    const e = 'https://e.rpc'
    const result = await checkMainnet([A, B, c, d, e], world({ [A]: down, [B]: unauthorized, [c]: html, [d]: noResult, [e]: notHex }).fetch)
    expect(result).toEqual({ usable: [A, B, c, d, e], wrong: [] })
  })

  it('keeps a server that does not answer in time', async () => {
    const hang = async (): Promise<Response> => await new Promise<Response>(() => {})
    const result = await checkMainnet([A, B], world({ [A]: hang, [B]: chain('0x1') }).fetch, 50)
    expect(result.usable).toEqual([A, B])
  })

  it('keeps the order the person gave', async () => {
    const result = await checkMainnet([A, B, 'https://c.rpc'], world({ [A]: chain('0x1'), [B]: chain('0x5'), 'https://c.rpc': chain('0x1') }).fetch)
    expect(result.usable).toEqual([A, 'https://c.rpc'])
  })
})

describe('wrongChainText', () => {
  it('names the server masked and the chain, nothing of its address beyond that', () => {
    const text = wrongChainText(A, 11155111n)
    expect(text).toBe('a.rpc/•••• is not Ethereum mainnet (chain 11155111)')
    expect(text).not.toContain('FAKE-KEY')
  })
})
