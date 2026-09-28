import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FromHost, LightClientConfig } from '../../protocol.js'
import { REFRESH_RETRY_MS, SYNC_WAIT_MS, startHeliosLightClient } from '../light-client.js'
import type { LightClient } from '../../service.js'

// startHeliosLightClient dynamically imports '@a16z/helios' (its own file
// header explains why: the light client's own module-scope side effects,
// same reasoning as favicon.ts's dynamic 'electron' import elsewhere in
// this codebase), so the mock has to be registered before it is ever
// evaluated -- vi.mock is hoisted above this file's own imports regardless
// of where it is written, which is what makes that work.
vi.mock('@a16z/helios', () => ({ createHeliosProvider: vi.fn() }))
const { createHeliosProvider } = await import('@a16z/helios')

const CHECKPOINT = `0x${'ab'.repeat(32)}`
const CONFIG: LightClientConfig = { executionRpcs: ['https://rpc.example'], consensusRpc: 'https://beacon.example', checkpoint: CHECKPOINT }

interface HeadAnswer { readonly number: string, readonly timestamp: string }

/** A fake Helios client whose head answer is swapped out mid-test via
 * `behavior.head`, so a test can move from "synced" to "every refresh
 * fails" without recreating the client. */
function fakeHelios (): { request: (args: { method: string, params?: unknown }) => Promise<unknown>, waitSynced: () => Promise<void>, destroy: () => Promise<void>, behavior: { head: () => HeadAnswer, destroyed: boolean } } {
  const behavior = { head: (): HeadAnswer => ({ number: '0x1', timestamp: '0x658c1234' }), destroyed: false }
  return {
    request: async ({ method, params }) => {
      if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'latest') return behavior.head()
      if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'finalized') return { timestamp: '0x658c1234' }
      if (method === 'helios_getCurrentCheckpoint') return `0x${'cd'.repeat(32)}`
      if (method === 'eth_chainId') return '0x1' // an arbitrary passthrough call, for provider.request()'s own tests
      throw new Error(`unexpected method in test: ${method}`)
    },
    waitSynced: async () => {},
    destroy: async () => { behavior.destroyed = true },
    behavior
  }
}

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(createHeliosProvider).mockReset()
  globalThis.fetch = originalFetch
  // eslint-disable-next-line @typescript-eslint/no-extra-non-null-assertion
  Object.defineProperty(globalThis, 'WebSocket', { value: originalWebSocket, configurable: true, writable: true })
})

async function synced (client: LightClient): Promise<void> {
  await vi.waitFor(() => { if (client.status().state !== 'synced') throw new Error('not synced yet') }, { timeout: 5_000 })
}

describe('startHeliosLightClient -- one bad refresh does not fail every mount', () => {
  it('reaches synced after the initial sync', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)
    expect(client.status()).toMatchObject({ state: 'synced' })
  })

  it('a single failed refresh, inside the grace window, leaves the client synced and answering', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)

    helios.behavior.head = () => { throw new Error('transient RPC blip') }
    await vi.advanceTimersByTimeAsync(60_000 + 100) // one REFRESH_MS tick, plus slack

    expect(client.status()).toMatchObject({ state: 'synced' }) // not downgraded
    await expect(client.provider.request({ method: 'eth_chainId' })).resolves.toBeDefined()
  })

  // The documented second trigger (ADR-0030's 2026-09-26 amendment, this
  // directory's own README): two failures in a row downgrades even well
  // within the grace window, since that reads as more than a single blip.
  it('two consecutive failed refreshes downgrade, even minutes inside the grace window', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)

    helios.behavior.head = () => { throw new Error('down') }
    await vi.advanceTimersByTimeAsync(60_000 + 100) // first failure -- still synced (previous test)
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS + 100) // second failure, seconds later

    expect(client.status().state).not.toBe('synced')
  })

  it('a success between two failures resets the streak, so a THIRD failure alone does not downgrade', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)

    helios.behavior.head = () => { throw new Error('blip 1') }
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    helios.behavior.head = () => ({ number: '0x2', timestamp: '0x658c9999' })
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS + 100)
    expect(client.status()).toMatchObject({ state: 'synced' })

    helios.behavior.head = () => { throw new Error('blip 2') }
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    expect(client.status()).toMatchObject({ state: 'synced' }) // one failure since the reset, not two
  })

  it('does not re-read the checkpoint on a fast retry, only on the ordinary cadence', async () => {
    const helios = fakeHelios()
    let checkpointReads = 0
    vi.mocked(createHeliosProvider).mockResolvedValue({
      ...helios,
      request: async (args: { method: string, params?: unknown }) => {
        if (args.method === 'helios_getCurrentCheckpoint') checkpointReads++
        return await helios.request(args)
      }
    } as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)
    expect(checkpointReads).toBe(1) // the initial one, alongside the first successful sync

    helios.behavior.head = () => { throw new Error('down') }
    await vi.advanceTimersByTimeAsync(60_000 + REFRESH_RETRY_MS * 8 + 100) // several fast retries
    expect(checkpointReads).toBe(1) // none of the fast retries re-asked
  })

  it('repeated failures past the grace window downgrade to syncing, and a request then waits and fails not-synced', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)

    helios.behavior.head = () => { throw new Error('still down') }
    // Past HEAD_GRACE_MS (2 min) of nothing but failed refreshes, each REFRESH_RETRY_MS (5s) apart.
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000)

    expect(client.status().state).not.toBe('synced')
    // The rejection expectation is attached BEFORE advancing time, not
    // after: request()'s own SYNC_WAIT_MS race only settles once the timer
    // below actually fires, and attaching .rejects afterward would let the
    // rejection go briefly unobserved in between (a real one Node would
    // flag, harmless here only because this file awaits it a tick later).
    const requested = expect(client.provider.request({ method: 'eth_chainId' })).rejects.toMatchObject({ failure: 'not-synced' })
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS + 100)
    await requested
  })

  it('recovers to synced once a refresh succeeds again after the grace window passed', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)

    helios.behavior.head = () => { throw new Error('down for a while') }
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000)
    expect(client.status().state).not.toBe('synced')

    helios.behavior.head = () => ({ number: '0x2', timestamp: '0x658c9999' })
    await vi.advanceTimersByTimeAsync(10_000)
    await synced(client)
    expect(client.status()).toMatchObject({ state: 'synced', block: 2 })
  })

  it('a checkpoint read failing never changes state -- only the head read does', async () => {
    const helios = fakeHelios()
    const reportedTypes: string[] = []
    vi.mocked(createHeliosProvider).mockResolvedValue({
      ...helios,
      request: async (args: { method: string, params?: unknown }) => {
        if (args.method === 'helios_getCurrentCheckpoint') throw new Error('checkpoint RPC down')
        return await helios.request(args)
      }
    } as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, (m: FromHost) => { reportedTypes.push(m.type) })
    await synced(client)
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    expect(client.status()).toMatchObject({ state: 'synced' })
    expect(reportedTypes).not.toContain('checkpoint')
    expect(reportedTypes.filter((t) => t === 'status')).not.toHaveLength(0)
  })
})
