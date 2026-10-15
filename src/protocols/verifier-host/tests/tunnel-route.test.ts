// A request the shell marked as a tunnel-profile website's is served from protocols that reach the network through the
// routed fetch and nothing else: the choice per route, the Swarm refusal, the light client of its own, and CCIP-Read.

import { request } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDag, fakeGateways } from '../../ipfs/tests/dag.test-helpers.js'
import { referenceCid } from '../../swarm/reference.js'
import { buildSite } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { EgressRefused, guardedCcipRequest } from '../egress.js'
import type { FromHost, HostConfig, LightClientConfig } from '../protocol.js'
import { ResolutionError } from '../../resolution/records.js'
import { DIRECT_ROUTE, RouteMeter, TUNNEL_PROFILE } from '../../route-pace.js'
import { paceOn } from '../pace.js'
import { startHost } from '../service.js'
import type { HostDeps, LightClient, RunningHost } from '../service.js'
import { SWARM_NOT_TUNNELLED, tunnelCcipDeps } from '../tunnel-protocols.js'
import { TunnelUnavailable } from '../routed-fetch.js'

const DIRECT_PACE = paceOn(DIRECT_ROUTE)
const TUNNEL_PACE = paceOn(new RouteMeter(TUNNEL_PROFILE))

const GATEWAY = 'https://a.gateway'
const dag = await buildDag({ 'index.html': '<h1>fixture</h1>' })
const running: RunningHost[] = []
afterEach(() => { for (const host of running.splice(0)) host.server.close() })

function config (overrides: Partial<HostConfig> = {}): HostConfig {
  return { port: 0, lightClient: undefined, gateways: [GATEWAY], unproxiedGateways: [], ccipDirect: false, ipnsNameServices: [], dnsOverHttps: ['https://dns.example/q'], ipnsSequences: {}, swarmEndpoints: [], swarmFeedIndexes: {}, fixtures: { 'fixture.eth': `ipfs://${dag.root.toString()}` }, ...overrides }
}

interface Spied extends HostDeps {
  readonly direct: string[]
  readonly routed: string[]
  readonly posted: FromHost[]
}

/** A host whose direct fetch and routed fetch both serve the gateway, and each says when it was used. */
function deps (overrides: Partial<HostDeps> = {}): Spied {
  const direct: string[] = []
  const routed: string[] = []
  const posted: FromHost[] = []
  const gw = fakeGateways(dag.blocks)
  const serve = async (url: string, init?: RequestInit): Promise<Response> => await gw.fetch(url, { headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? new AbortController().signal })
  return {
    direct,
    routed,
    posted,
    fetch: async (url, init) => { direct.push(url); return await serve(url, init) },
    routedFetch: async (url, init) => { routed.push(url); return await serve(url, init) },
    resolveHost: async () => { throw new Error('no name is resolved in this test') },
    post: (message) => { posted.push(message) },
    startLightClient: () => { throw new Error('no light client in this test') },
    fixturesAllowed: true,
    directFetch: async () => { throw new Error('no direct fetch in this test') },
    ccipFetch: async () => { throw new Error('no CCIP fetch in this test') },
    ...overrides
  }
}

/** `document`: asked for as a page is, so a failure is not read again before the error page, as a file of a page would be. */
async function get (port: number, host: string, tunnel: boolean, path = '/', document = false): Promise<{ status: number, body: string }> {
  return await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host, 'x-orivon-partition': `https://${host}`, ...(tunnel ? { 'x-orivon-route': 'tunnel' } : {}), ...(document ? { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } : {}) } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    }).on('error', reject).end()
  })
}

describe('the route a request takes', () => {
  it('reads a tunnel-profile website from the routed fetch alone', async () => {
    const spied = deps()
    const host = await startHost(config(), spied)
    running.push(host)
    expect(await get(host.port, 'fixture.eth', true)).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(spied.routed.length).toBeGreaterThan(0)
    expect(spied.direct).toEqual([])
  })

  it('reads any other website from the ordinary fetch, and never from the routed one', async () => {
    const spied = deps()
    const host = await startHost(config(), spied)
    running.push(host)
    expect(await get(host.port, 'fixture.eth', false)).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(spied.direct.length).toBeGreaterThan(0)
    expect(spied.routed).toEqual([])
  })

  it('keeps what each route mounted apart: a name proved through the tunnel is not the record a direct website is served', async () => {
    const spied = deps()
    const host = await startHost(config(), spied)
    running.push(host)
    await get(host.port, 'fixture.eth', true)
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth', route: 'tunnel' })).not.toBeNull()
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth' })).toBeNull()
    expect(await host.answer({ kind: 'mount', host: 'fixture.eth', partition: 'https://fixture.eth', route: 'tunnel' })).toMatchObject({ host: 'fixture.eth' })
  })

  it('fails when the tunnel does, and reads nothing around it', async () => {
    const spied = deps({ routedFetch: async () => { throw new TunnelUnavailable('the tunnel is down') } })
    const host = await startHost(config(), spied)
    running.push(host)
    const answer = await get(host.port, 'fixture.eth', true, '/', true)
    expect(answer.status).toBeGreaterThanOrEqual(500)
    expect(spied.direct).toEqual([])
  }, 40_000)

  it('treats a mark a page could have forged as no mark at all when it is not exactly tunnel', async () => {
    const spied = deps()
    const host = await startHost(config(), spied)
    running.push(host)
    await new Promise<void>((resolve, reject) => {
      request({ host: '127.0.0.1', port: host.port, path: '/', servername: 'fixture.eth', rejectUnauthorized: false, headers: { host: 'fixture.eth', 'x-orivon-partition': 'https://fixture.eth', 'x-orivon-route': 'Tunnel' } }, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject).end()
    })
    expect(spied.routed).toEqual([])
  })
})

describe('Swarm for a tunnel-profile website', () => {
  async function swarmHost () {
    const chunks = new Map<string, Uint8Array>()
    const site = buildSite({ 'index.html': '<h1>on swarm</h1>' }, chunks)
    const spied = deps()
    const host = await startHost(config({ swarmEndpoints: ['https://swarm.endpoint'], fixtures: { 'swarm.eth': `bzz://${site}` } }), spied)
    running.push(host)
    return { host, spied, cid: referenceCid(site) }
  }

  it('is refused with a plain sentence, for an address and for a name, and nothing is fetched', async () => {
    const { host, spied, cid } = await swarmHost()
    for (const name of [`${cid}.bzz.orivon`, 'swarm.eth']) {
      const answer = await get(host.port, name, true)
      expect(answer.status).toBeGreaterThanOrEqual(400)
      expect(answer.body).toContain('cannot send its traffic through your tunnel')
    }
    expect(spied.direct).toEqual([])
    expect(spied.routed).toEqual([])
  })

  it('says the same words everywhere it is told', () => {
    expect(SWARM_NOT_TUNNELLED).toContain('Swarm node Orivon runs on this computer')
  })
})

describe('the light client of a tunnel-profile website', () => {
  const CONFIG: LightClientConfig = { executionRpcs: ['https://rpc.example'], consensusRpc: 'https://beacon.example', checkpoint: `0x${'ab'.repeat(32)}` }

  it('starts at the first tunnel-profile name that needs it, never before, and fetches through the routed fetch only', async () => {
    const starts: Array<{ route: 'tunnel' | undefined, fetch: HostDeps['fetch'] }> = []
    const lightClient = (): LightClient => ({ status: () => ({ state: 'off' }), provider: { request: async () => { throw new ResolutionError('not-synced', 'the light client is still syncing') } } })
    const spied = deps({ startLightClient: (_config, fetch, _report, route) => { starts.push({ route, fetch }); return lightClient() } })
    const host = await startHost(config({ lightClient: CONFIG }), spied)
    running.push(host)
    expect(starts.map((start) => start.route)).toEqual([undefined])

    await get(host.port, 'unknown.eth', true)
    expect(starts.map((start) => start.route)).toEqual([undefined, 'tunnel'])
    await get(host.port, 'other.eth', true)
    expect(starts).toHaveLength(2)

    const tunnelFetch = starts[1]?.fetch as HostDeps['fetch']
    await tunnelFetch('https://rpc.example/', { method: 'POST', body: '{}' }).catch(() => {})
    await tunnelFetch('https://beacon.example/eth/v1/beacon/headers').catch(() => {})
    expect(spied.routed).toEqual(['https://rpc.example/', 'https://beacon.example/eth/v1/beacon/headers'])
    expect(spied.direct).toEqual([])
    await expect(tunnelFetch('https://elsewhere.example/')).rejects.toBeInstanceOf(EgressRefused)
  })

  it('is told to wait the tunnel\'s time for a first sync, and the shared client is told the same, and to start late, only while the whole browser is on the tunnel', async () => {
    const waits: Array<{ route: 'tunnel' | undefined, wait: number | undefined, startAfter: number | undefined }> = []
    const lightClient = (): LightClient => ({ status: () => ({ state: 'off' }), provider: { request: async () => { throw new ResolutionError('not-synced', 'x') } } })
    const record = (_config: LightClientConfig, _fetch: HostDeps['fetch'], _report: unknown, route?: 'tunnel', pace?: { syncWaitMs: number, startAfterMs: number }): LightClient => { waits.push({ route, wait: pace?.syncWaitMs, startAfter: pace?.startAfterMs }); return lightClient() }
    const direct = await startHost(config({ lightClient: CONFIG }), deps({ startLightClient: record }))
    running.push(direct)
    await get(direct.port, 'unknown.eth', true)
    expect(waits).toEqual([{ route: undefined, wait: DIRECT_PACE.syncWaitMs, startAfter: 0 }, { route: 'tunnel', wait: TUNNEL_PACE.syncWaitMs, startAfter: 0 }])
    waits.length = 0
    const through = await startHost(config({ lightClient: CONFIG, front: { port: 1, username: 'u', password: 'p' } }), deps({ startLightClient: record }))
    running.push(through)
    expect(waits).toEqual([{ route: undefined, wait: TUNNEL_PACE.syncWaitMs, startAfter: TUNNEL_PACE.lightClientStartAfterMs }])
  })

  it('never starts for a website that is not in the tunnel profile', async () => {
    const starts = vi.fn(() => { throw new Error('unexpected') })
    const host = await startHost(config({ lightClient: undefined }), deps({ startLightClient: starts }))
    running.push(host)
    await get(host.port, 'fixture.eth', false)
    expect(starts).not.toHaveBeenCalled()
  })
})

describe('CCIP-Read for a tunnel-profile website', () => {
  const parameters = (url: string): Parameters<typeof guardedCcipRequest>[0] => ({ sender: '0x0000000000000000000000000000000000000001', data: '0x1234', urls: [url] }) as never

  it('is sent through the routed fetch with the name unresolved here', async () => {
    const seen: string[] = []
    const fetch: HostDeps['fetch'] = async (url) => { seen.push(url); return new Response(JSON.stringify({ data: '0xabcd' }), { headers: { 'content-type': 'application/json' } }) }
    await expect(guardedCcipRequest(parameters('https://ccip.example/{sender}/{data}.json'), tunnelCcipDeps(fetch))).resolves.toBe('0xabcd')
    expect(seen).toEqual(['https://ccip.example/0x0000000000000000000000000000000000000001/0x1234.json'])
  })

  it('still refuses what the fence refuses: a private address, a port other than 443, and plain http', async () => {
    const fetch: HostDeps['fetch'] = async () => { throw new Error('must not be reached') }
    for (const url of ['https://10.0.0.1/{data}', 'https://127.0.0.1/{data}', 'https://ccip.example:8443/{data}', 'http://ccip.example/{data}']) {
      await expect(guardedCcipRequest(parameters(url), tunnelCcipDeps(fetch))).rejects.toThrow(/no offchain gateway answered/)
    }
  })
})
