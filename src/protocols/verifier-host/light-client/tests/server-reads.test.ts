import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LightClientConfig } from '../../protocol.js'
import { resetHeliosClock } from '../clock.js'
import { startHeliosLightClient } from '../light-client.js'
import { failoverRpc } from '../rpc-failover.js'
import { SERVER_READ_TIMEOUT_MS, ServerReadError, serverReads } from '../server-reads.js'
import type { WebFetch } from '../../egress.js'

// See light-client.test.ts for why Helios is mocked.
vi.mock('@a16z/helios', () => ({ createHeliosProvider: vi.fn() }))
const { createHeliosProvider } = await import('@a16z/helios')

const URL = 'https://direct-execution.orivon.invalid'
const logsRequest = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] }
const answer = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
const failure = (code: number, message: string, status = 200): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), { status })
const caught = async (promise: Promise<unknown>): Promise<ServerReadError> => {
  const error = await promise.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(ServerReadError)
  return error as ServerReadError
}

describe('serverReads', () => {
  it('posts the request as JSON-RPC and answers the result', async () => {
    const sent: { url: string, init: RequestInit | undefined }[] = []
    const fetch: WebFetch = async (url, init) => { sent.push({ url, init }); return answer([{ blockNumber: '0x1' }]) }
    expect(await serverReads(() => fetch, URL).request(logsRequest)).toEqual([{ blockNumber: '0x1' }])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(URL)
    expect(sent[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(sent[0]?.init?.body))).toMatchObject({ jsonrpc: '2.0', method: 'eth_getLogs', params: logsRequest.params })
    expect(sent[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('answers a transaction, and null for one the servers do not know', async () => {
    const reads = serverReads(() => async () => answer(null), URL)
    expect(await reads.request({ method: 'eth_getTransactionByHash', params: ['0x01'] })).toBeNull()
  })

  it('reads nothing else: state is the light client\'s, so every other method is refused before a request is made', async () => {
    const fetch = vi.fn<WebFetch>(async () => answer('0x1'))
    const reads = serverReads(() => fetch, URL)
    for (const method of ['eth_call', 'eth_getStorageAt', 'eth_getProof', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_sendRawTransaction']) {
      expect(await caught(reads.request({ method, params: [] }))).toMatchObject({ code: 4200 })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('takes the servers now in use at each request, since a start that drops one replaces them', async () => {
    let now: WebFetch = async () => answer('first')
    const reads = serverReads(() => now, URL)
    expect(await reads.request(logsRequest)).toBe('first')
    now = async () => answer('second')
    expect(await reads.request(logsRequest)).toBe('second')
  })

  it('says a JSON-RPC refusal by its code and the server\'s words, whatever the HTTP status', async () => {
    const wide = serverReads(() => async () => failure(35, 'ranges over 100 blocks are not supported', 400), URL)
    expect(await caught(wide.request(logsRequest))).toMatchObject({ code: 35, message: 'ranges over 100 blocks are not supported' })
    const exceeds = serverReads(() => async () => failure(-32602, 'query exceeds limit'), URL)
    expect(await caught(exceeds.request(logsRequest))).toMatchObject({ code: -32602, message: 'query exceeds limit' })
  })

  it('says a rate limit as 429 with the wait the server asked, and never repeats the body of an answer that is not JSON-RPC', async () => {
    const limited = serverReads(() => async () => new Response('error code: 1015', { status: 429, headers: { 'retry-after': '3' } }), URL)
    const error = await caught(limited.request(logsRequest))
    expect(error).toMatchObject({ code: 429, retryAfterMs: 3_000 })
    expect(error.message).not.toContain('1015')
    const zero = serverReads(() => async () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }), URL)
    expect(await caught(zero.request(logsRequest))).toMatchObject({ code: 429, retryAfterMs: 0 })
    const bodied = serverReads(() => async () => failure(-32005, 'limit exceeded', 429), URL)
    expect(await caught(bodied.request(logsRequest))).toMatchObject({ code: 429 })
  })

  it('says a 503 that names a wait as a rate limit, whatever its body carries, and one that names none as its status', async () => {
    const waiting = serverReads(() => async () => new Response('busy', { status: 503, headers: { 'retry-after': '5' } }), URL)
    expect(await caught(waiting.request(logsRequest))).toMatchObject({ code: 503, retryAfterMs: 5_000 })
    const bodied = serverReads(() => async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'overloaded' } }), { status: 503, headers: { 'retry-after': '2' } }), URL)
    expect(await caught(bodied.request(logsRequest))).toMatchObject({ code: 429, retryAfterMs: 2_000 })
    const silent = serverReads(() => async () => failure(-32000, 'overloaded', 503), URL)
    expect(await caught(silent.request(logsRequest))).toMatchObject({ code: -32000, retryAfterMs: undefined })
  })

  it('aborts a read the server never answers at 25 seconds, and says it as a provider that is disconnected', async () => {
    vi.useFakeTimers()
    const limits: number[] = []
    // The abort `AbortSignal.timeout` makes runs on the runtime's own timer, which the fake clock does not move: the same abort on the fake one.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      limits.push(ms)
      const controller = new AbortController()
      setTimeout(() => { controller.abort(new Error('the read timed out')) }, ms)
      return controller.signal
    })
    try {
      const hung: WebFetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('the read timed out')) }) })
      let ended = false
      const outcome = caught(serverReads(() => hung, URL).request(logsRequest)).finally(() => { ended = true })
      await vi.advanceTimersByTimeAsync(24_999)
      expect(ended).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toMatchObject({ code: 4900, message: 'the read timed out' })
      expect(limits).toEqual([25_000])
      expect(SERVER_READ_TIMEOUT_MS).toBe(25_000)
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })

  it('says an archive refusal as its status', async () => {
    const archive = serverReads(() => async () => new Response('Archive requests require a personal token', { status: 403 }), URL)
    const error = await caught(archive.request(logsRequest))
    expect(error).toMatchObject({ code: 403, message: 'the execution servers answered 403' })
  })

  it('says a connection that failed as a provider that is disconnected, with no address in the words', async () => {
    const reads = serverReads(() => async () => { throw new Error('connect ECONNREFUSED https://secret.rpc.example/v3/KEY') }, URL, (text) => text.replaceAll('https://secret.rpc.example/v3/KEY', 'an execution server'))
    const error = await caught(reads.request(logsRequest))
    expect(error).toMatchObject({ code: 4900 })
    expect(error.message).toBe('connect ECONNREFUSED an execution server')
  })

  it('masks the words of a server\'s own refusal', async () => {
    const reads = serverReads(() => async () => failure(-32000, 'https://secret.rpc.example/v3/KEY said no'), URL, (text) => text.replaceAll('https://secret.rpc.example/v3/KEY', 'an execution server'))
    expect(await caught(reads.request(logsRequest))).toMatchObject({ message: 'an execution server said no' })
  })

  it('refuses an answer that is not JSON-RPC', async () => {
    const reads = serverReads(() => async () => new Response('<html>'), URL)
    expect(await caught(reads.request(logsRequest))).toMatchObject({ code: -32603 })
  })

  it('goes through the failover: a server that rate limits is passed over for the next, which answers', async () => {
    const A = 'https://a.rpc'
    const B = 'https://b.rpc'
    const asked: string[] = []
    const fetch: WebFetch = async (url) => {
      asked.push(url)
      return url === A ? new Response('error code: 1015', { status: 429, headers: { 'retry-after': '0' } }) : answer([])
    }
    const failover = failoverRpc([A, B], fetch)
    const reads = serverReads(() => failover, URL)
    expect(await reads.request(logsRequest)).toEqual([])
    expect(asked).toEqual([A, B])
    // The server that limited it is cooling for at least a second, though it asked for none, so the next request goes to the other first.
    asked.length = 0
    expect(await reads.request(logsRequest)).toEqual([])
    expect(asked[0]).toBe(B)
  })
})

describe('the light client\'s server reads', () => {
  const CONFIG: LightClientConfig = { executionRpcs: ['https://rpc.example'], consensusRpc: 'https://beacon.example', checkpoint: `0x${'ab'.repeat(32)}` }
  const helios = {
    request: async ({ method, params }: { method: string, params?: unknown }): Promise<unknown> => {
      if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'latest') return { number: '0x1', timestamp: '0x658c1234' }
      if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'finalized') return { timestamp: '0x658c1234' }
      if (method === 'helios_getCurrentCheckpoint') return `0x${'cd'.repeat(32)}`
      throw new Error(`unexpected method in test: ${method}`)
    },
    waitSynced: async () => {},
    destroy: async () => {}
  }
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    resetHeliosClock()
    vi.useRealTimers()
    vi.mocked(createHeliosProvider).mockReset()
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'WebSocket', { value: originalWebSocket, configurable: true, writable: true })
  })

  it('asks the servers the light client uses, through its own fetch, and nothing that is not a log or a transaction', async () => {
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const asked: { url: string, body: string }[] = []
    const fetch = (async (url: string, init?: RequestInit) => { asked.push({ url, body: String(init?.body) }); return answer([{ blockNumber: '0x1' }]) }) as never
    const client = startHeliosLightClient(CONFIG, fetch, () => {})
    await vi.waitFor(() => { if (client.status().state !== 'synced') throw new Error('not synced yet') }, { timeout: 5_000 })
    asked.length = 0
    expect(await client.serverReads?.request(logsRequest)).toEqual([{ blockNumber: '0x1' }])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.url).toBe('https://rpc.example')
    expect(JSON.parse(asked[0]?.body ?? '{}')).toMatchObject({ method: 'eth_getLogs' })
    expect(await caught(client.serverReads?.request({ method: 'eth_call', params: [] }) ?? Promise.reject(new Error('no serverReads')))).toMatchObject({ code: 4200 })
    expect(asked).toHaveLength(1)
  })

  it('works before the light client has synced: it needs none of its proofs', async () => {
    vi.mocked(createHeliosProvider).mockReturnValue(new Promise(() => {}))
    const fetch = (async () => answer([])) as never
    const client = startHeliosLightClient(CONFIG, fetch, () => {})
    expect(await client.serverReads?.request(logsRequest)).toEqual([])
  })
})
