import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ENDPOINTS } from '../../../../main/verifier/endpoints.js'
import { allowlisted } from '../../egress.js'
import { heliosClockLead, resetHeliosClock } from '../clock.js'
import { CLOCK_BEHIND_REASON } from '../helios-errors.js'
import { startHeliosLightClient } from '../light-client.js'
import type { LightClient } from '../../service.js'

// Opt-in, live: ORIVON_LIVE_ETH=1 npx vitest run src/protocols/verifier-host/light-client/tests/live-clock.test.ts
// It runs the real Helios against the real beacon API and RPCs, with this process's clock set behind them.

const LIVE = process.env['ORIVON_LIVE_ETH'] === '1'
const nodeFetch = globalThis.fetch
const realNow = Date.now
const BEHIND_MS = 120_000

async function checkpoint (): Promise<string> {
  const body = await (await nodeFetch(`${DEFAULT_ENDPOINTS.consensusRpc}/eth/v1/beacon/states/head/finality_checkpoints`)).json() as { data: { finalized: { root: string } } }
  return body.data.finalized.root
}

async function until (client: LightClient, state: string, ms: number): Promise<void> {
  const deadline = realNow() + ms
  while (client.status().state !== state) {
    if (realNow() > deadline) throw new Error(`light client did not reach ${state}: ${JSON.stringify(client.status())}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe.skipIf(!LIVE)('the light client on a computer whose clock is behind, live', () => {
  beforeEach(() => { Date.now = () => realNow() - BEHIND_MS })
  afterEach(() => { resetHeliosClock(); Date.now = realNow })

  it('is refused by Helios itself when it cannot allow for the clock, and says so in plain words', async () => {
    const root = await checkpoint()
    const servers = [...DEFAULT_ENDPOINTS.executionRpcs, DEFAULT_ENDPOINTS.consensusRpc]
    const reach = allowlisted(servers, async (url, init) => await nodeFetch(url, init), 'the light client')
    // HEAD is how the clock is measured; with it refused there is no lead to lend, and Helios's own refusal is what remains.
    const client = startHeliosLightClient({ executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: root }, async (url, init) => await reach(url, init?.method === 'HEAD' ? { ...init, method: 'OPTIONS', signal: AbortSignal.abort() } : init), () => {})
    await until(client, 'failed', 120_000)
    expect(client.status()).toMatchObject({ state: 'failed', reason: CLOCK_BEHIND_REASON })
    expect(heliosClockLead()).toBe(0)
  }, 180_000)

  it('syncs and follows the chain, with the servers\' time lent to Helios alone', async () => {
    const root = await checkpoint()
    const servers = [...DEFAULT_ENDPOINTS.executionRpcs, DEFAULT_ENDPOINTS.consensusRpc]
    const fetch = allowlisted(servers, async (url, init) => await nodeFetch(url, init), 'the light client')
    const client = startHeliosLightClient({ executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: root }, fetch, () => {})
    await until(client, 'synced', 120_000)
    expect(heliosClockLead()).toBeGreaterThan(BEHIND_MS - 10_000)
    expect(heliosClockLead()).toBeLessThan(BEHIND_MS + 10_000)
    const state = client.status()
    expect(state).toMatchObject({ state: 'synced', clockLeadMs: heliosClockLead() })
    expect(await client.provider.request({ method: 'eth_blockNumber' })).toMatch(/^0x[0-9a-f]+$/)
    // Everything else in the process still reads the clock it has.
    expect(realNow() - Date.now()).toBeGreaterThan(BEHIND_MS - 1_000)
  }, 180_000)
})
