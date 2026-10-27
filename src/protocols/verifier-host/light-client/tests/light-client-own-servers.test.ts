import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LightClientConfig } from '../../protocol.js'
import { startHeliosLightClient } from '../light-client.js'
import type { LightClient } from '../../service.js'
import { resetHeliosClock } from '../clock.js'

// See light-client.test.ts for why Helios is mocked and how its fake behaves.
vi.mock('@a16z/helios', () => ({ createHeliosProvider: vi.fn() }))
const { createHeliosProvider } = await import('@a16z/helios')

const CHECKPOINT = `0x${'ab'.repeat(32)}`
const CONFIG: LightClientConfig = { executionRpcs: ['https://rpc.example'], consensusRpc: 'https://beacon.example', checkpoint: CHECKPOINT }

interface HeadAnswer { readonly number: string, readonly timestamp: string }

function fakeHelios (): { request: (args: { method: string, params?: unknown }) => Promise<unknown>, waitSynced: () => Promise<void>, destroy: () => Promise<void>, behavior: { head: () => HeadAnswer } } {
  const behavior = { head: (): HeadAnswer => ({ number: '0x1', timestamp: '0x658c1234' }) }
  return {
    request: async ({ method, params }) => {
      if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'latest') return behavior.head()
      if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'finalized') return { timestamp: '0x658c1234' }
      if (method === 'helios_getCurrentCheckpoint') return `0x${'cd'.repeat(32)}`
      throw new Error(`unexpected method in test: ${method}`)
    },
    waitSynced: async () => {},
    destroy: async () => {},
    behavior
  }
}

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  resetHeliosClock()
  vi.useRealTimers()
  vi.mocked(createHeliosProvider).mockReset()
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis, 'WebSocket', { value: originalWebSocket, configurable: true, writable: true })
})

async function synced (client: LightClient): Promise<void> {
  await vi.waitFor(() => { if (client.status().state !== 'synced') throw new Error('not synced yet') }, { timeout: 5_000 })
}

describe('startHeliosLightClient -- servers the person named', () => {
  const KEY = 'FAKE-KEY-0123456789abcdef'
  const A = `https://mainnet.infura.io/v3/${KEY}`
  const B = 'https://b.rpc'
  const OWN: LightClientConfig = { ...CONFIG, executionRpcs: [A, B], consensusRpc: `http://127.0.0.1:5052/k/${KEY}`, ownServers: { execution: true, consensus: true } }
  const answerWith = (id: string): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }))
  const failed = async (client: LightClient): Promise<void> => {
    await vi.waitFor(() => { if (client.status().state !== 'failed') throw new Error('not failed yet') }, { timeout: 5_000 })
  }
  const rpc = '{"jsonrpc":"2.0","id":1,"method":"eth_getProof","params":[]}'
  type Names = { executionRpc: string, consensusRpc: string }
  const heliosNames = (): Names => (vi.mocked(createHeliosProvider).mock.calls as unknown as Array<[Names]>)[0]![0]

  it('asks each of the person\'s servers for its chain, drops one on another chain and sends the proofs to the rest', async () => {
    vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
    const asked: string[] = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${String(init?.body).includes('eth_chainId') ? 'chain' : 'other'}`)
      return answerWith(url === A ? '0xaa36a7' : '0x1')
    })
    const client = startHeliosLightClient(OWN, fetch as never, () => {})
    await synced(client)
    await globalThis.fetch(new Request(heliosNames().executionRpc, { method: 'POST', body: rpc }))
    expect(asked.filter((entry) => entry.endsWith('chain')).sort()).toEqual([`${A} chain`, `${B} chain`].sort())
    expect(asked.filter((entry) => entry.endsWith('other'))).toEqual([`${B} other`])
  })

  it('fails with a sentence naming the server masked when none of them is mainnet, and never starts Helios', async () => {
    vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
    const client = startHeliosLightClient(OWN, (async () => answerWith('0xaa36a7')) as never, () => {})
    await failed(client)
    const status = client.status()
    expect(status).toMatchObject({ state: 'failed', reason: 'mainnet.infura.io/•••• is not Ethereum mainnet (chain 11155111); b.rpc is not Ethereum mainnet (chain 11155111)' })
    expect(createHeliosProvider).not.toHaveBeenCalled()
  })

  it('does not ask Orivon\'s own servers for their chain', async () => {
    vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
    const fetch = vi.fn(async () => answerWith('0xaa36a7'))
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: OWN.executionRpcs, consensusRpc: OWN.consensusRpc }, fetch as never, () => {})
    await synced(client)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('names the server that broke, masked, with what it answered, when Helios fails with every one of them in trouble', async () => {
    vi.mocked(createHeliosProvider).mockImplementation((async (given: Names) => {
      await globalThis.fetch(new Request(given.executionRpc, { method: 'POST', body: rpc }))
      throw new Error(`error sending request for url (${given.executionRpc}/): status 401`)
    }) as never)
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(init?.body).includes('eth_chainId')) return answerWith('0x1')
      return new Response('no', { status: url === A ? 401 : 429 })
    }
    const client = startHeliosLightClient(OWN, fetch as never, () => {})
    await failed(client)
    const status = client.status()
    expect(status).toMatchObject({ state: 'failed', reason: 'mainnet.infura.io/•••• answered 401; b.rpc answered 429 (error sending request for url (https://mainnet.infura.io/••••/): status 401)' })
    expect(JSON.stringify(status)).not.toContain(KEY)
  })

  it('does not fold a server\'s trouble in while another of them is well', async () => {
    vi.mocked(createHeliosProvider).mockImplementation((async (given: Names) => {
      await globalThis.fetch(new Request(given.executionRpc, { method: 'POST', body: rpc }))
      throw new Error('sync failed')
    }) as never)
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(init?.body).includes('eth_chainId')) return answerWith('0x1')
      return url === A ? new Response('no', { status: 401 }) : answerWith('0x1')
    }
    const client = startHeliosLightClient(OWN, fetch as never, () => {})
    await failed(client)
    expect(client.status()).toMatchObject({ state: 'failed', reason: 'sync failed' })
  })

  it('leaves Orivon\'s servers\' failures as they read, whatever answered', async () => {
    vi.mocked(createHeliosProvider).mockImplementation((async (given: Names) => {
      await globalThis.fetch(new Request(given.executionRpc, { method: 'POST', body: rpc }))
      throw new Error('sync failed')
    }) as never)
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: OWN.executionRpcs, consensusRpc: OWN.consensusRpc }, (async () => new Response('no', { status: 503 })) as never, () => {})
    await failed(client)
    expect(client.status()).toMatchObject({ state: 'failed', reason: 'sync failed' })
  })

  it('shows the lane names Helios quotes as the servers, with no key in the failed reason', async () => {
    vi.mocked(createHeliosProvider).mockImplementation((async (given: Names) => {
      throw new Error(`could not fetch bootstrap: error sending request for url (${given.consensusRpc}/eth/v1/beacon/light_client/bootstrap/0x01) caused by https://mainnet.infura.io/v3/${KEY}`)
    }) as never)
    const client = startHeliosLightClient(OWN, (async () => answerWith('0x1')) as never, () => {})
    await failed(client)
    const status = client.status()
    expect(status).toMatchObject({ state: 'failed', reason: 'could not fetch bootstrap: error sending request for url (http://127.0.0.1:5052/••••/eth/v1/beacon/light_client/bootstrap/0x01) caused by https://mainnet.infura.io/••••' })
    expect(JSON.stringify(status)).not.toContain(KEY)
  })

  it('logs a refresh failure without the key, and answers a failed call without it', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue({
      ...helios,
      request: async (args: { method: string, params?: unknown }) => {
        if (args.method === 'eth_call') throw new Error(`error sending request for url (https://direct-execution.orivon.invalid/) and ${A}`)
        return await helios.request(args)
      }
    } as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = startHeliosLightClient(OWN, (async () => answerWith('0x1')) as never, () => {})
      await synced(client)
      helios.behavior.head = () => { throw new Error(`fetch failed: ${A}`) }
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      const rejection = await client.provider.request({ method: 'eth_call' }).catch((error: unknown) => error as Error) as Error
      expect(rejection.message).toBe('error sending request for url (https://mainnet.infura.io/••••/) and https://mainnet.infura.io/••••')
      expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY)
      expect(JSON.stringify(logged.mock.calls)).toContain('light client refresh failed')
    } finally {
      logged.mockRestore()
    }
  })
})

