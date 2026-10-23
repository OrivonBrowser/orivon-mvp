import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FromHost, LightClientConfig } from '../../protocol.js'
import { REFRESH_RETRY_MS, SYNC_WAIT_MS, startHeliosLightClient } from '../light-client.js'
import type { LightClient } from '../../service.js'
import { heliosClockLead, resetHeliosClock } from '../clock.js'
import { CLOCK_BEHIND_REASON } from '../helios-errors.js'

// startHeliosLightClient dynamically imports '@a16z/helios' (its own file
// header explains why: the light client's own module-scope side effects,
// same reasoning as favicon-fetch.ts's dynamic 'electron' import elsewhere in
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
  resetHeliosClock()
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

  // The documented second trigger (ADR-0030, this directory's README): two
  // failures in a row downgrade even well within the grace window, since
  // that reads as more than a single blip.
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

  it('waits the time it was given for a first sync, not the direct one', async () => {
    const helios = fakeHelios()
    let finish: () => void = () => {}
    helios.waitSynced = async () => await new Promise<void>((resolve) => { finish = resolve })
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {}, 'direct', { syncWaitMs: 40_000, startAfterMs: 0 })
    await vi.advanceTimersByTimeAsync(10)
    let answer: string | undefined
    void client.provider.request({ method: 'eth_chainId' }).then(() => { answer = 'answered' }, (error: unknown) => { answer = `failed: ${(error as Error).message}` })
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS + 1_000)
    expect(answer, 'still waiting after the direct time').toBeUndefined()
    finish()
    await vi.advanceTimersByTimeAsync(100)
    expect(answer).toBe('answered')
  })

  it('with a start delay, waits to sync until a request needs it or the delay is over, whichever comes first', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const later = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {}, 'direct', { syncWaitMs: 8_000, startAfterMs: 60_000 })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(createHeliosProvider).not.toHaveBeenCalled()
    expect(later.status().state).toBe('starting')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(createHeliosProvider).toHaveBeenCalledTimes(1)
    await synced(later)

    vi.mocked(createHeliosProvider).mockClear()
    const asked = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {}, 'direct', { syncWaitMs: 8_000, startAfterMs: 60_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createHeliosProvider).not.toHaveBeenCalled()
    const answered = asked.provider.request({ method: 'eth_chainId' })
    await vi.advanceTimersByTimeAsync(100)
    expect(createHeliosProvider).toHaveBeenCalledTimes(1)
    await expect(answered).resolves.toBe('0x1')
  })

  it('wakes a request waiting while syncing as soon as a refresh recovers, not after SYNC_WAIT_MS', async () => {
    const helios = fakeHelios()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient(CONFIG, (async () => new Response('{}')) as never, () => {})
    await synced(client)
    helios.behavior.head = () => { throw new Error('down') }
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS + 100) // second failure: syncing
    expect(client.status().state).toBe('syncing')

    let settled: string | undefined
    const waiting = client.provider.request({ method: 'eth_chainId' }).then(() => { settled = 'answered' }, (error: unknown) => { settled = `failed: ${(error as Error).message}` })
    helios.behavior.head = () => ({ number: '0x2', timestamp: '0x658c9999' })
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS + 100) // the retry succeeds
    expect(client.status().state).toBe('synced')
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe('answered')
    await waiting
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

describe('startHeliosLightClient -- a computer whose clock is behind the chain', () => {
  const CLOCK_ERROR = 'sync failed: invalid timestamp'
  /** Servers whose clocks are `ahead` ms in front of this computer's. */
  const serversAhead = (ahead: number) => (async () => new Response(null, { headers: { date: new Date(Date.now() + ahead).toUTCString() } })) as never
  const failFirstSync = (): ReturnType<typeof fakeHelios> => {
    const helios = fakeHelios()
    helios.waitSynced = vi.fn().mockRejectedValueOnce(new Error(CLOCK_ERROR)).mockResolvedValue(undefined)
    return helios
  }

  it('lends Helios the servers\' time and starts it again at once, reporting how far behind the clock is', async () => {
    const helios = failFirstSync()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, serversAhead(90_000), () => {})
    await synced(client)

    expect(createHeliosProvider).toHaveBeenCalledTimes(2)
    expect(heliosClockLead()).toBeGreaterThan(88_000)
    expect(heliosClockLead()).toBeLessThan(92_000)
    expect(client.status()).toMatchObject({ state: 'synced', clockLeadMs: heliosClockLead() })
  })

  it('does not touch a client whose clock is right: no lead, no second start, nothing reported', async () => {
    vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
    const client = startHeliosLightClient(CONFIG, serversAhead(0), () => {})
    await synced(client)

    expect(createHeliosProvider).toHaveBeenCalledTimes(1)
    expect(heliosClockLead()).toBe(0)
    expect(client.status()).not.toHaveProperty('clockLeadMs')
  })

  it("says it in plain words when the servers' time cannot be used, and keeps trying by the ordinary backoff", async () => {
    const helios = fakeHelios()
    helios.waitSynced = async () => { throw new Error(CLOCK_ERROR) }
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, (async () => { throw new Error('no route') }) as never, () => {})
    await vi.waitFor(() => { if (client.status().state !== 'failed') throw new Error('not failed yet') }, { timeout: 5_000 })

    expect(client.status()).toMatchObject({ state: 'failed', reason: CLOCK_BEHIND_REASON })
    expect(heliosClockLead()).toBe(0)
    await expect(client.provider.request({ method: 'eth_chainId' })).rejects.toMatchObject({ failure: 'not-synced', message: expect.stringContaining(CLOCK_BEHIND_REASON) as unknown })
  })

  it('does not start again at once more than one time when the lead was not enough', async () => {
    const helios = fakeHelios()
    helios.waitSynced = async () => { throw new Error(CLOCK_ERROR) }
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, serversAhead(90_000), () => {})
    await vi.waitFor(() => { if (client.status().state !== 'failed') throw new Error('not failed yet') }, { timeout: 5_000 })

    expect(createHeliosProvider).toHaveBeenCalledTimes(2)
    // A lead was lent, so "set the clock right" is no longer the whole story: Helios's own words stand.
    expect(client.status()).toMatchObject({ state: 'failed', reason: CLOCK_ERROR })
  })

  it("keeps the lead when the servers cannot be asked again after the system clock was set, as after the computer wakes", async () => {
    const helios = failFirstSync()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    let reachable = true
    const reach = (async () => {
      if (!reachable) throw new Error('no route')
      return new Response(null, { headers: { date: new Date(Date.now() + 90_000).toUTCString() } })
    }) as never
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, reach, () => {})
    await synced(client)
    const lead = heliosClockLead()
    expect(lead).toBeGreaterThan(88_000)

    reachable = false
    vi.setSystemTime(Date.now() + 3_600_000)
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    expect(heliosClockLead()).toBe(lead)
  })

  it("drops the lead when the system clock was set right while the client ran", async () => {
    const helios = failFirstSync()
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    let ahead = 90_000
    const reach = (async () => new Response(null, { headers: { date: new Date(Date.now() + ahead).toUTCString() } })) as never
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, reach, () => {})
    await synced(client)
    expect(heliosClockLead()).toBeGreaterThan(88_000)

    vi.setSystemTime(Date.now() + 90_000)
    ahead = 0
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    expect(heliosClockLead()).toBe(0)
    expect(client.status()).not.toHaveProperty('clockLeadMs')
  })

  it("shows Helios's own words when the servers say the clock is right", async () => {
    const helios = fakeHelios()
    helios.waitSynced = async () => { throw new Error(CLOCK_ERROR) }
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, serversAhead(0), () => {})
    await vi.waitFor(() => { if (client.status().state !== 'failed') throw new Error('not failed yet') }, { timeout: 5_000 })

    expect(createHeliosProvider).toHaveBeenCalledTimes(1)
    expect(client.status()).toMatchObject({ state: 'failed', reason: CLOCK_ERROR })
  })

  it('says a failure is the consensus server having no bootstrap for the checkpoint', async () => {
    const helios = fakeHelios()
    helios.waitSynced = async () => { throw new Error('could not fetch bootstrap: rpc error on method: bootstrap, message: status: 404, message: NOT_FOUND') }
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, serversAhead(0), () => {})
    await vi.waitFor(() => { if (client.status().state !== 'failed') throw new Error('not failed yet') }, { timeout: 5_000 })
    expect(client.status()).toMatchObject({ state: 'failed', bootstrapMissing: true })
  })

  it('lowers a lead the servers no longer agree with when the client fails for another reason', async () => {
    const helios = fakeHelios()
    let ahead = 90_000
    helios.waitSynced = vi.fn()
      .mockRejectedValueOnce(new Error(CLOCK_ERROR))
      .mockImplementationOnce(async () => { ahead = 0; throw new Error('checkpoint is too old') })
    vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
    const reach = (async () => new Response(null, { headers: { date: new Date(Date.now() + ahead).toUTCString() } })) as never
    const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, reach, () => {})
    await vi.waitFor(() => { if (client.status().state !== 'failed') throw new Error('not failed yet') }, { timeout: 5_000 })

    expect(client.status()).toMatchObject({ state: 'failed', reason: 'checkpoint is too old' })
    expect(heliosClockLead()).toBe(0)
  })

  describe('while it runs', () => {
    /** A client that has synced on a lead of 90 s, with servers whose answer the test controls: `ahead`, or unreachable. */
    async function running () {
      const helios = failFirstSync()
      vi.mocked(createHeliosProvider).mockResolvedValue(helios as never)
      const world = { ahead: 90_000, reachable: true, asked: 0 }
      const reach = (async () => {
        world.asked++
        if (!world.reachable) throw new Error('no route')
        return new Response(null, { headers: { date: new Date(Date.now() + world.ahead).toUTCString() } })
      }) as never
      const client = startHeliosLightClient({ ...CONFIG, executionRpcs: ['https://rpc.example', 'https://rpc2.example'] }, reach, () => {})
      await synced(client)
      expect(heliosClockLead()).toBeGreaterThan(88_000)
      world.asked = 0
      return { helios, client, world }
    }

    it('asks again after a measurement that could not be made, until the servers answer, and then takes the lead back', async () => {
      const { client, world } = await running()
      world.reachable = false
      vi.setSystemTime(Date.now() + 3_600_000)
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      expect(world.asked).toBe(3)
      expect(heliosClockLead()).toBeGreaterThan(88_000)

      world.reachable = true
      world.ahead = 0
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      expect(heliosClockLead()).toBe(0)
      expect(client.status()).not.toHaveProperty('clockLeadMs')
    })

    it('asks at most once a minute while a measurement is due', async () => {
      const { helios, world } = await running()
      world.reachable = false
      vi.setSystemTime(Date.now() + 3_600_000)
      helios.behavior.head = () => { throw new Error('transient RPC blip') }
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      expect(world.asked).toBe(3)
      await vi.advanceTimersByTimeAsync(3 * REFRESH_RETRY_MS)
      expect(world.asked).toBe(3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(world.asked).toBe(6)
    })

    it('measures when the system clock is set back, even with no lead lent', async () => {
      vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
      const world = { ahead: 0, asked: 0 }
      const reach = (async () => {
        world.asked++
        return new Response(null, { headers: { date: new Date(Date.now() + world.ahead).toUTCString() } })
      }) as never
      const client = startHeliosLightClient(CONFIG, reach, () => {})
      await synced(client)
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      expect(world.asked).toBe(0)

      vi.setSystemTime(Date.now() - 3_600_000)
      world.ahead = 3_600_000
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      expect(heliosClockLead()).toBeGreaterThan(3_500_000)
      expect(client.status()).toMatchObject({ state: 'synced', clockLeadMs: heliosClockLead() })
    })

    it('measures nothing when the clock is set forward or the computer wakes while no lead is lent', async () => {
      vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
      let asked = 0
      const reach = (async () => { asked++; return new Response(null, { headers: { date: new Date().toUTCString() } }) }) as never
      const client = startHeliosLightClient(CONFIG, reach, () => {})
      await synced(client)
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      vi.setSystemTime(Date.now() + 3_600_000)
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      expect(asked).toBe(0)
    })

    it('measures again when the client stalls while a lead is lent', async () => {
      const { helios, client, world } = await running()
      world.ahead = 0
      helios.behavior.head = () => { throw new Error('down') }
      await vi.advanceTimersByTimeAsync(60_000 + 100)
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS + 100)
      expect(client.status().state).not.toBe('synced')
      helios.behavior.head = () => ({ number: '0x6', timestamp: '0x658c9999' })
      await vi.advanceTimersByTimeAsync(REFRESH_RETRY_MS + 100)
      expect(heliosClockLead()).toBe(0)
    })
  })
})

describe('startHeliosLightClient -- a second client for the tunnel', () => {
  const answer = async (_url: string, _init?: RequestInit): Promise<Response> => new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { headers: { 'content-type': 'application/json' } })

  async function bothClients () {
    vi.mocked(createHeliosProvider).mockResolvedValue(fakeHelios() as never)
    const direct = vi.fn(answer)
    const tunnel = vi.fn(answer)
    const first = startHeliosLightClient(CONFIG, direct as never, () => {})
    // The module is imported once before the second client asks for it: two imports of a mocked module at the same moment can give the second the real one.
    await synced(first)
    const second = startHeliosLightClient(CONFIG, tunnel as never, () => {}, 'nym')
    await synced(second)
    const [one, two] = (vi.mocked(createHeliosProvider).mock.calls as unknown as Array<[{ executionRpc: string, consensusRpc: string }]>).map(([config]) => config)
    return { direct, tunnel, one: one as { executionRpc: string, consensusRpc: string }, two: two as { executionRpc: string, consensusRpc: string } }
  }

  it('gives each Helios its own names for the two servers, the tunnel\'s resolving nowhere', async () => {
    const { one, two } = await bothClients()
    expect(one).toMatchObject({ executionRpc: 'https://rpc.example', consensusRpc: 'https://beacon.example' })
    expect(two.executionRpc).toMatch(/\.invalid/)
    expect(two.consensusRpc).toMatch(/\.invalid/)
  })

  it('sends the tunnel client\'s requests to the tunnel\'s fetch alone, at the real servers', async () => {
    const { direct, tunnel, two } = await bothClients()
    await globalThis.fetch(new Request(two.executionRpc, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }))
    await globalThis.fetch(`${two.consensusRpc}/eth/v1/beacon/light_client/bootstrap/0x01?x=1`)
    expect(tunnel.mock.calls.map(([url]) => url)).toEqual(['https://rpc.example', 'https://beacon.example/eth/v1/beacon/light_client/bootstrap/0x01?x=1'])
    expect(direct).not.toHaveBeenCalled()
  })

  it('keeps the first client\'s requests on its own fetch', async () => {
    const { direct, tunnel } = await bothClients()
    await globalThis.fetch(new Request('https://rpc.example', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' }))
    await globalThis.fetch('https://beacon.example/eth/v1/beacon/headers')
    expect(direct.mock.calls.map(([url]) => url)).toEqual(['https://rpc.example', 'https://beacon.example/eth/v1/beacon/headers'])
    expect(tunnel).not.toHaveBeenCalled()
  })

  it('refuses a request to any other address, rather than hand it to either client\'s fetch', async () => {
    const { direct, tunnel } = await bothClients()
    await expect(globalThis.fetch('https://elsewhere.example/')).rejects.toThrow(/no client of this process uses/)
    expect(direct).not.toHaveBeenCalled()
    expect(tunnel).not.toHaveBeenCalled()
  })
})
