import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createEnsResolver } from '../../../ens/resolver.js'
import { DEFAULT_ENDPOINTS } from '../../../main/verifier/endpoints.js'
import { allowlisted, guardedCcipRequest } from '../../egress.js'
import { startHeliosLightClient } from '../light-client.js'
import type { LightClient } from '../../service.js'

// Opt-in, live: ORIVON_LIVE_ETH=1 npx vitest run src/verifier-host/light-client/tests/live-ens.test.ts
// It contacts mainnet RPC and beacon endpoints, so no ordinary run does.

const LIVE = process.env['ORIVON_LIVE_ETH'] === '1'
const nodeFetch = globalThis.fetch

/** The configured beacon API's finalized root: this test is about resolution, not about choosing a checkpoint. */
async function checkpoint (): Promise<string> {
  const body = await (await nodeFetch(`${DEFAULT_ENDPOINTS.consensusRpc}/eth/v1/beacon/states/head/finality_checkpoints`)).json() as { data: { finalized: { root: string } } }
  return body.data.finalized.root
}

async function until (client: LightClient, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (client.status().state !== 'synced') {
    if (Date.now() > deadline) throw new Error(`light client did not sync: ${JSON.stringify(client.status())}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe.skipIf(!LIVE)('ENS through the light client, live', () => {
  let proxy: Server
  let proxyUrl = ''

  beforeAll(async () => {
    // Forwards to the real execution RPC, altering one byte of every eth_getProof answer.
    proxy = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        void (async () => {
          const upstream = await nodeFetch(DEFAULT_ENDPOINTS.executionRpcs[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          let text = await upstream.text()
          if (body.includes('eth_getProof')) text = text.replace(/"(0x[0-9a-f]{40,})"/, (_m, hex: string) => `"${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}"`)
          res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text)
        })()
      })
    })
    await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
  })
  afterAll(() => { proxy.close() })

  it('resolves the five names to the kinds their contenthashes name', async () => {
    const root = await checkpoint()
    const fetch = allowlisted([...DEFAULT_ENDPOINTS.executionRpcs, DEFAULT_ENDPOINTS.consensusRpc], async (url, init) => await nodeFetch(url, init), 'the light client')
    const client = startHeliosLightClient({ executionRpcs: DEFAULT_ENDPOINTS.executionRpcs, consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: root }, fetch, () => {})
    await until(client, 120_000)
    const resolver = createEnsResolver({ provider: client.provider, ccipRequest: async (p) => await guardedCcipRequest(p, { fetch: async (url, init) => await nodeFetch(url, init), resolveHost: async () => ['93.184.216.34'] }) })
    const kinds: Record<string, string | undefined> = {}
    for (const name of ['vitalik.eth', 'ens.eth', 'tornadocash.eth', 'app.ens.eth', 'uniswap.eth']) {
      const [record] = await resolver.resolve(name)
      kinds[name] = record?.pointer.kind
      expect(record?.provenance.via).toBe('chain')
    }
    expect(kinds).toEqual({ 'vitalik.eth': 'ipfs', 'ens.eth': 'ipfs', 'tornadocash.eth': 'ipfs', 'app.ens.eth': 'ipns-key', 'uniswap.eth': 'dnslink' })
  }, 240_000)

  it('refuses the answer when the RPC alters a proof', async () => {
    const root = await checkpoint()
    const fetch = allowlisted([proxyUrl, DEFAULT_ENDPOINTS.consensusRpc], async (url, init) => await nodeFetch(url, init), 'the light client')
    const client = startHeliosLightClient({ executionRpcs: [proxyUrl], consensusRpc: DEFAULT_ENDPOINTS.consensusRpc, checkpoint: root }, fetch, () => {})
    await until(client, 120_000)
    const resolver = createEnsResolver({ provider: client.provider, ccipRequest: async () => { throw new Error('no offchain lookup expected') } })
    await expect(resolver.resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'unverifiable' })
  }, 240_000)
})
