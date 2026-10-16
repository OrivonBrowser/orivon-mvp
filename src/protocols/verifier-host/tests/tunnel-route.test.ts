// A request the shell marked as a tunnel-profile website's is served from protocols that reach the network through the
// routed fetch and nothing else: the choice per route, the Swarm refusal, the light client of its own, and CCIP-Read.

import { request } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDag, fakeGateways } from '../../ipfs/tests/dag.test-helpers.js'
import { referenceCid } from '../../swarm/reference.js'
import { buildSite } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { EgressRefused, guardedCcipRequest } from '../egress.js'
import type { FromHost, HostConfig, LightClientConfig, TunnelRoute } from '../protocol.js'
import { ResolutionError } from '../../resolution/records.js'
import { DIRECT_ROUTE, RouteMeter, TUNNEL_PROFILE } from '../../route-pace.js'
import { paceOn } from '../pace.js'
import { startHost } from '../service.js'
import type { HostDeps, LightClient, RunningHost } from '../service.js'
import { IPFS_NOT_TUNNELLED, SWARM_NOT_TUNNELLED, tunnelCcipDeps } from '../tunnel-protocols.js'
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
    routedFetch: () => async (url, init) => { routed.push(url); return await serve(url, init) },
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
async function get (port: number, host: string, tunnel: boolean | TunnelRoute, path = '/', document = false): Promise<{ status: number, body: string }> {
  return await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host, 'x-orivon-partition': `https://${host}`, ...(tunnel === false ? {} : { 'x-orivon-route': tunnel === true ? 'nym' : tunnel }), ...(document ? { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } : {}) } }, (res) => {
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
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth', route: 'nym' })).not.toBeNull()
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth' })).toBeNull()
    expect(await host.answer({ kind: 'mount', host: 'fixture.eth', partition: 'https://fixture.eth', route: 'nym' })).toMatchObject({ host: 'fixture.eth' })
  })

  it('fails when the tunnel does, and reads nothing around it', async () => {
    const spied = deps({ routedFetch: () => async () => { throw new TunnelUnavailable('the tunnel is down') } })
    const host = await startHost(config(), spied)
    running.push(host)
    const answer = await get(host.port, 'fixture.eth', true, '/', true)
    expect(answer.status).toBeGreaterThanOrEqual(500)
    expect(spied.direct).toEqual([])
  }, 40_000)

  it('treats a mark a page could have forged as no mark at all when it is not exactly a tunnel', async () => {
    const spied = deps()
    const host = await startHost(config(), spied)
    running.push(host)
    await new Promise<void>((resolve, reject) => {
      request({ host: '127.0.0.1', port: host.port, path: '/', servername: 'fixture.eth', rejectUnauthorized: false, headers: { host: 'fixture.eth', 'x-orivon-partition': 'https://fixture.eth', 'x-orivon-route': 'Nym' } }, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject).end()
    })
    expect(spied.routed).toEqual([])
  })
})

describe('two tunnels at once', () => {
  /** A host whose routed fetch is told apart by the tunnel it was made for, so each says what went through it. */
  function perTunnel () {
    const made: TunnelRoute[] = []
    const through: Record<TunnelRoute, string[]> = { nym: [], socks5: [] }
    const gw = fakeGateways(dag.blocks)
    const spied = deps({
      routedFetch: (tunnel) => {
        made.push(tunnel)
        return async (url, init) => { through[tunnel].push(url); return await gw.fetch(url, { headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? new AbortController().signal }) }
      }
    })
    return { spied, made, through }
  }

  it('reads a website of each tunnel through that tunnel\'s fetch alone', async () => {
    const { spied, through } = perTunnel()
    const host = await startHost(config(), spied)
    running.push(host)
    expect(await get(host.port, 'fixture.eth', 'nym')).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(through.nym.length).toBeGreaterThan(0)
    expect(through.socks5, 'Nym\'s website never used the proxy\'s fetch').toEqual([])
    const before = through.nym.length
    expect(await get(host.port, 'fixture.eth', 'socks5')).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(through.socks5.length).toBeGreaterThan(0)
    expect(through.nym.length, 'and the proxy\'s website never used Nym\'s').toBe(before)
    expect(spied.direct).toEqual([])
  })

  it('starts the protocols of a tunnel at the first request that names it, and no more than once', async () => {
    const { spied, made } = perTunnel()
    const host = await startHost(config(), spied)
    running.push(host)
    expect(made, 'nothing for a tunnel nobody uses').toEqual([])
    await get(host.port, 'fixture.eth', 'socks5')
    await get(host.port, 'fixture.eth', 'socks5')
    expect(made).toEqual(['socks5'])
  })

  it('keeps what each tunnel mounted apart from the other\'s and from the direct route\'s', async () => {
    const { spied } = perTunnel()
    const host = await startHost(config(), spied)
    running.push(host)
    await get(host.port, 'fixture.eth', 'nym')
    const asked = (route?: TunnelRoute) => host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth', ...(route === undefined ? {} : { route }) })
    expect(await asked('nym')).not.toBeNull()
    expect(await asked('socks5')).toBeNull()
    expect(await asked()).toBeNull()
  })

  it('fails the website of a tunnel that is down without trying the other tunnel or the direct fetch', async () => {
    const { spied, through } = perTunnel()
    const down = deps({ routedFetch: (tunnel) => tunnel === 'socks5' ? async () => { throw new TunnelUnavailable('the proxy is down') } : spied.routedFetch(tunnel) })
    const host = await startHost(config(), down)
    running.push(host)
    const answer = await get(host.port, 'fixture.eth', 'socks5', '/', true)
    expect(answer.status).toBeGreaterThanOrEqual(500)
    expect(through.nym).toEqual([])
    expect(down.direct).toEqual([])
  }, 40_000)

  it('proves the names of each tunnel\'s websites with a light client of its own', async () => {
    const CONFIG: LightClientConfig = { executionRpcs: ['https://rpc.example'], consensusRpc: 'https://beacon.example', checkpoint: `0x${'ab'.repeat(32)}` }
    const starts: Array<TunnelRoute | undefined> = []
    const quiet = (): LightClient => ({ status: () => ({ state: 'off' }), provider: { request: async () => { throw new ResolutionError('not-synced', 'x') } } })
    const host = await startHost(config({ lightClient: CONFIG }), deps({ startLightClient: (_config, _fetch, _report, route) => { starts.push(route); return quiet() } }))
    running.push(host)
    await get(host.port, 'unknown.eth', 'nym')
    await get(host.port, 'unknown.eth', 'socks5')
    await get(host.port, 'other.eth', 'socks5')
    expect(starts).toEqual([undefined, 'nym', 'socks5'])
  })
})

const DOCUMENT = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

describe('the IPFS node for a tunnel-profile website', () => {
  const NODE = 'http://127.0.0.1:20123'
  const NODE_CONFIG = { endpoint: NODE, partitionSalt: 'ab'.repeat(32), lookupService: true }

  async function started (overrides: Partial<HostConfig>) {
    const spied = deps({
      // The node is on loopback and answers like a gateway; the routed fetch answers the gateways only.
      fetch: async (url, init) => { spied.direct.push(url); return await fakeGateways(dag.blocks).fetch(url, { headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? new AbortController().signal }) }
    })
    const host = await startHost(config({ ipfsNode: NODE_CONFIG, ...overrides }), spied)
    running.push(host)
    return { host, spied }
  }

  async function tunnelGet (port: number, headers: Record<string, string> = {}): Promise<{ status: number, body: string }> {
    return await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/', servername: 'fixture.eth', rejectUnauthorized: false, headers: { host: 'fixture.eth', 'x-orivon-partition': 'https://fixture.eth', 'x-orivon-route': 'nym', ...headers } }, (res) => {
        let body = ''
        res.on('data', (c: Buffer) => { body += c.toString() })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
      }).on('error', reject).end()
    })
  }

  it('serves the website from the node when the nodes may serve such a website, reading the node on loopback and nothing through the tunnel', async () => {
    const { host, spied } = await started({ tunnelSitesReadNodes: true })
    const page = tunnelGet(host.port)
    await vi.waitFor(() => { expect(spied.posted).toContainEqual({ type: 'node-wanted', node: 'ipfs-node' }) })
    host.node({ type: 'node', node: 'ipfs-node', state: 'ready' })
    expect(await page).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(spied.direct.length).toBeGreaterThan(0)
    expect(spied.direct.every((url) => url.startsWith(`${NODE}/`))).toBe(true)
    expect(spied.routed).toEqual([])
  })

  it('never asks the node, and reads no gateway, when the nodes run outside a tunnel they were asked to follow; it offers the gateways instead', async () => {
    const { host, spied } = await started({})
    const answer = await tunnelGet(host.port, DOCUMENT)
    expect(answer.status).toBe(502)
    expect(answer.body).toContain(IPFS_NOT_TUNNELLED.replaceAll('"', '&#34;'))
    expect(answer.body).toContain('the tunnel&#39;s exit address')
    expect(spied.posted).not.toContainEqual({ type: 'node-wanted', node: 'ipfs-node' })
    expect(spied.routed).toEqual([])
    expect(spied.direct).toEqual([])
  })

  it('reads the gateways through the tunnel, and only those, after the person\'s yes for this site', async () => {
    const { host, spied } = await started({})
    const refused = await tunnelGet(host.port, DOCUMENT)
    const href = /id="load-through-gateways" href="([^"]+)"/.exec(refused.body)?.[1]?.replaceAll('&#38;', '&') ?? ''
    const accepted = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: host.port, path: href, servername: 'fixture.eth', rejectUnauthorized: false, headers: { host: 'fixture.eth', 'x-orivon-partition': 'https://fixture.eth', 'x-orivon-route': 'nym', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' } }, (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0) }) }).on('error', reject).end()
    })
    expect(accepted).toBe(303)
    expect(await tunnelGet(host.port, DOCUMENT)).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(spied.routed.length).toBeGreaterThan(0)
    expect(spied.direct).toEqual([])
  })

  it('reads the gateways through the tunnel, as the person chose, when the source is gateways and no node is configured', async () => {
    const spied = deps()
    const host = await startHost(config(), spied)
    running.push(host)
    expect(await get(host.port, 'fixture.eth', true)).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(spied.direct).toEqual([])
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
      expect(answer.body).toContain('cannot send its traffic through the tunnel')
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
    const starts: Array<{ route: TunnelRoute | undefined, fetch: HostDeps['fetch'] }> = []
    const lightClient = (): LightClient => ({ status: () => ({ state: 'off' }), provider: { request: async () => { throw new ResolutionError('not-synced', 'the light client is still syncing') } } })
    const spied = deps({ startLightClient: (_config, fetch, _report, route) => { starts.push({ route, fetch }); return lightClient() } })
    const host = await startHost(config({ lightClient: CONFIG }), spied)
    running.push(host)
    expect(starts.map((start) => start.route)).toEqual([undefined])

    await get(host.port, 'unknown.eth', true)
    expect(starts.map((start) => start.route)).toEqual([undefined, 'nym'])
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
    const waits: Array<{ route: TunnelRoute | undefined, wait: number | undefined, startAfter: number | undefined }> = []
    const lightClient = (): LightClient => ({ status: () => ({ state: 'off' }), provider: { request: async () => { throw new ResolutionError('not-synced', 'x') } } })
    const record = (_config: LightClientConfig, _fetch: HostDeps['fetch'], _report: unknown, route?: TunnelRoute, pace?: { syncWaitMs: number, startAfterMs: number }): LightClient => { waits.push({ route, wait: pace?.syncWaitMs, startAfter: pace?.startAfterMs }); return lightClient() }
    const direct = await startHost(config({ lightClient: CONFIG }), deps({ startLightClient: record }))
    running.push(direct)
    await get(direct.port, 'unknown.eth', true)
    expect(waits).toEqual([{ route: undefined, wait: DIRECT_PACE.syncWaitMs, startAfter: 0 }, { route: 'nym', wait: TUNNEL_PACE.syncWaitMs, startAfter: 0 }])
    waits.length = 0
    const through = await startHost(config({ lightClient: CONFIG, front: { port: 1, username: 'u', password: 'p' } }), deps({ startLightClient: record }))
    running.push(through)
    expect(waits).toEqual([{ route: undefined, wait: TUNNEL_PACE.syncWaitMs, startAfter: TUNNEL_PACE.lightClientStartAfterMs }])
  })

  describe('when the light client runs outside the tunnel', () => {
    const FRONT = { port: 1, username: 'u', password: 'p' }
    const quiet = (): LightClient => ({ status: () => ({ state: 'off' }), provider: { request: async () => { throw new ResolutionError('not-synced', 'x') } } })

    it('leaves through the outside fetch while the whole browser is on the tunnel, never the front, and syncs at the direct pace', async () => {
      const starts: Array<{ fetch: HostDeps['fetch'], pace: { syncWaitMs: number, startAfterMs: number } | undefined }> = []
      const outside: string[] = []
      const spied = deps({
        startLightClient: (_config, fetch, _report, _route, pace) => { starts.push({ fetch, pace }); return quiet() },
        outside: { send: async (url) => { outside.push(url); return new Response('{}') }, resolveHost: async () => ['93.184.216.34'] }
      })
      const host = await startHost(config({ lightClient: CONFIG, front: FRONT, ethereumOutside: true }), spied)
      running.push(host)
      expect(starts).toHaveLength(1)
      expect(starts[0]?.pace).toEqual({ syncWaitMs: DIRECT_PACE.syncWaitMs, startAfterMs: 0 })
      await starts[0]?.fetch('https://rpc.example/', { method: 'POST', body: '{}' })
      expect(outside).toEqual(['https://rpc.example/'])
      expect(spied.direct).toEqual([])
      expect(spied.routed).toEqual([])
    })

    it('proves a tunnel-profile website\'s name with the shared client, and starts no client of its own', async () => {
      const routes: Array<TunnelRoute | undefined> = []
      const spied = deps({ startLightClient: (_config, _fetch, _report, route) => { routes.push(route); return quiet() } })
      const host = await startHost(config({ lightClient: CONFIG, ethereumOutside: true }), spied)
      running.push(host)
      await get(host.port, 'unknown.eth', true)
      await get(host.port, 'other.eth', true)
      expect(routes).toEqual([undefined])
    })

    it('follows the front when the host has no way outside the tunnel', async () => {
      const fetched: string[] = []
      const starts: Array<HostDeps['fetch']> = []
      const spied = deps({ fetch: async (url) => { fetched.push(url); return new Response('{}') }, startLightClient: (_config, fetch) => { starts.push(fetch); return quiet() } })
      const host = await startHost(config({ lightClient: CONFIG, front: FRONT, ethereumOutside: true }), spied)
      running.push(host)
      await starts[0]?.('https://rpc.example/', { method: 'POST', body: '{}' })
      expect(fetched).toEqual(['https://rpc.example/'])
    })
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
