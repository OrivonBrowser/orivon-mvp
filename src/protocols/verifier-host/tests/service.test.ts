import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import { buildDag, fakeGateways } from '../../ipfs/tests/dag.test-helpers.js'
import type { FromHost, HostConfig } from '../protocol.js'
import { startHost } from '../service.js'
import { startProtocols } from '../protocols.js'
import { BUILTIN_PROTOCOLS } from '../../builtin.js'
import type { HostDeps, RunningHost } from '../service.js'
import { referenceCid } from '../../swarm/reference.js'
import { TEST_KEY, TOPIC, fakeSwarm } from '../../swarm/tests/swarm.test-helpers.js'
import { buildFeedManifest, buildSite, legacyUpdate, ownerOf, signFeedUpdate } from '../../../../test/apps/swarm-gateway/encode.mjs'

const GATEWAY = 'https://a.gateway'
const dag = await buildDag({ 'index.html': '<h1>fixture</h1>' })
const running: RunningHost[] = []
afterEach(() => { for (const host of running.splice(0)) host.server.close() })

function config (overrides: Partial<HostConfig> = {}): HostConfig {
  return { port: 0, lightClient: undefined, gateways: [GATEWAY], unproxiedGateways: [], ccipDirect: false, ipnsNameServices: [], dnsOverHttps: ['https://dns.example/q'], ipnsSequences: {}, swarmEndpoints: [GATEWAY], swarmFeedIndexes: {}, fixtures: { 'fixture.eth': `ipfs://${dag.root.toString()}` }, ...overrides }
}

function deps (overrides: Partial<HostDeps> = {}): HostDeps & { posted: FromHost[] } {
  const posted: FromHost[] = []
  const gw = fakeGateways(dag.blocks)
  return {
    posted,
    fetch: async (url, init) => await gw.fetch(url, { headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? new AbortController().signal }),
    resolveHost: async () => ['93.184.216.34'],
    post: (message) => { posted.push(message) },
    startLightClient: () => { throw new Error('no light client in this test') },
    fixturesAllowed: true,
    directFetch: async () => { throw new Error('no direct fetch in this test -- config().unproxiedGateways is empty') },
    ccipFetch: async () => { throw new Error('no CCIP fetch in this test') },
    ...overrides
  }
}

async function get (port: number, host: string, path = '/', partition = `https://${host}`): Promise<{ status: number, body: string, location?: string | undefined }> {
  return await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host, 'x-orivon-partition': partition } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body, ...(res.headers.location === undefined ? {} : { location: res.headers.location }) }) })
    }).on('error', reject).end()
  })
}

describe('startHost with Swarm', () => {
  const ENDPOINT = 'https://swarm.endpoint'
  const OWNER = ownerOf(TEST_KEY)

  async function swarmWorld () {
    const chunks = new Map<string, Uint8Array>()
    const site = buildSite({ 'index.html': '<h1>on swarm</h1>', 'app.js': 'console.log(1)' }, chunks)
    const next = buildSite({ 'index.html': '<h1>newer</h1>' }, chunks)
    const feed = buildFeedManifest({ owner: OWNER, topic: TOPIC }, chunks)
    for (const [index, root] of [site, next].entries()) {
      const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index, wrapped: legacyUpdate(root) })
      chunks.set(update.address, update.chunk)
    }
    const swarm = fakeSwarm(chunks)
    return { site, next, feed, swarm }
  }

  it('serves a bzz:// address from its canonical origin, proven by the address, and checks every chunk', async () => {
    const { site, swarm } = await swarmWorld()
    const host = await startHost(config({ swarmEndpoints: [ENDPOINT] }), deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) }))
    running.push(host)
    const cid = referenceCid(site)
    expect(await get(host.port, 'bzz.orivon', `/${site}/`)).toMatchObject({ status: 301, location: `https://${cid}.bzz.orivon/` })
    expect(await get(host.port, `${cid}.bzz.orivon`)).toEqual({ status: 200, body: '<h1>on swarm</h1>' })
    expect(await get(host.port, `${cid}.bzz.orivon`, '/app.js')).toEqual({ status: 200, body: 'console.log(1)' })
    const provenance = await host.answer({ kind: 'provenance', host: `${cid}.bzz.orivon`, partition: `https://${cid}.bzz.orivon` })
    expect(provenance).toMatchObject({ resolver: 'bzz-address', root: { kind: 'swarm', cid }, pointers: [{ step: 'contenthash', provenance: { via: 'address' } }], ddoc: { status: 'met' } })
  })

  it('serves a fixture name whose contenthash is a feed, shows its newest update and reports the index it found', async () => {
    const { feed, next, swarm } = await swarmWorld()
    const posted: FromHost[] = []
    const host = await startHost(
      config({ swarmEndpoints: [ENDPOINT], fixtures: { 'feed.eth': `bzz://${feed}` } }),
      { ...deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) }), post: (message) => { posted.push(message) } }
    )
    running.push(host)
    expect(await get(host.port, 'feed.eth')).toEqual({ status: 200, body: '<h1>newer</h1>' })
    const provenance = await host.answer({ kind: 'provenance', host: 'feed.eth', partition: 'https://feed.eth' })
    expect(provenance).toMatchObject({ root: { kind: 'swarm', cid: referenceCid(next) }, pointers: [{ step: 'contenthash' }, { step: 'swarm-feed', index: 1n }] })
    expect(posted).toContainEqual({ type: 'swarm-feed-index', feed: `${OWNER}/${TOPIC}`, index: '1' })
  })

  it('reports a .eth name mounted from Swarm as a bzz name, and an address it serves as nothing', async () => {
    const { site, swarm } = await swarmWorld()
    const posted: FromHost[] = []
    const host = await startHost(
      config({ swarmEndpoints: [ENDPOINT], fixtures: { 'swarm.eth': `bzz://${site}` } }),
      { ...deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) }), post: (message) => { posted.push(message) } }
    )
    running.push(host)
    const cid = referenceCid(site)
    expect((await get(host.port, `${cid}.bzz.orivon`)).status).toBe(200)
    expect(posted.filter((message) => message.type === 'name-scheme')).toEqual([])
    expect((await get(host.port, 'swarm.eth')).status).toBe(200)
    expect(posted.filter((message) => message.type === 'name-scheme')).toEqual([{ type: 'name-scheme', host: 'swarm.eth', scheme: 'bzz' }])
  })

  it('does not fall back to an older update than an earlier run saw', async () => {
    const { feed, swarm } = await swarmWorld()
    const host = await startHost(
      config({ swarmEndpoints: [ENDPOINT], swarmFeedIndexes: { [`${OWNER}/${TOPIC}`]: '9' }, fixtures: { 'feed.eth': `bzz://${feed}` } }),
      deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) })
    )
    running.push(host)
    expect((await get(host.port, 'feed.eth')).status).toBe(502)
  })
})

describe('startProtocols', () => {
  it('runs exactly the protocols the shell routes and shows, in the same order', () => {
    expect(startProtocols(config(), deps()).protocols.map((p) => p.descriptor)).toEqual(BUILTIN_PROTOCOLS)
  })
})

describe('startHost', () => {
  it('serves an ipfs:// address from its canonical origin, with no light client, and calls it proven by the address', async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    const cid = dag.root.toV1().toString()
    const redirect = await get(host.port, 'ipfs.orivon', `/${dag.root.toV0().toString()}/`)
    expect(redirect).toMatchObject({ status: 301, location: `https://${cid}.ipfs.orivon/` })
    expect(await get(host.port, `${cid}.ipfs.orivon`)).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    const provenance = await host.answer({ kind: 'provenance', host: `${cid}.ipfs.orivon`, partition: `https://${cid}.ipfs.orivon` })
    expect(provenance).toMatchObject({ resolver: 'ipfs-address', pointers: [{ step: 'contenthash', provenance: { via: 'address' } }], ddoc: { status: 'met' } })
  })

  it('serves a fixture name from IPFS through the loopback server, and reports its provenance', async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    expect(host.fingerprint).toMatch(/^sha256\//)
    expect(await get(host.port, 'fixture.eth')).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    const provenance = await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth' })
    expect(provenance).toMatchObject({ host: 'fixture.eth', resolver: 'fixture', root: { kind: 'ipfs', cid: dag.root.toString() }, ddoc: { status: 'met' } })
  })

  it('reports a .eth name mounted from IPFS as an ipfs name, and an ipfs:// address it serves as nothing', async () => {
    const d = deps()
    const host = await startHost(config(), d)
    running.push(host)
    const cid = dag.root.toV1().toString()
    expect((await get(host.port, `${cid}.ipfs.orivon`)).status).toBe(200)
    expect(d.posted.filter((message) => message.type === 'name-scheme')).toEqual([])
    expect((await get(host.port, 'fixture.eth')).status).toBe(200)
    expect(d.posted.filter((message) => message.type === 'name-scheme')).toEqual([{ type: 'name-scheme', host: 'fixture.eth', scheme: 'ipfs' }])
  })

  it('reports nothing for a name that does not resolve', async () => {
    const d = deps()
    const host = await startHost(config(), d)
    running.push(host)
    expect((await get(host.port, 'unknown.eth')).status).toBeGreaterThanOrEqual(400)
    expect(d.posted.filter((message) => message.type === 'name-scheme')).toEqual([])
  })

  it("keeps a name one site's pages opened out of every other site's partition", async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    expect((await get(host.port, 'fixture.eth', '/', 'https://news.example')).status).toBe(200)
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://news.example' })).not.toBeNull()
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth' })).toBeNull()
    expect(await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://tracker.example' })).toBeNull()
  })

  it('refuses fixture names unless the build allows them, failing closed like any unverifiable name', async () => {
    const host = await startHost(config(), deps({ fixturesAllowed: false }))
    running.push(host)
    const reply = await get(host.port, 'fixture.eth')
    expect(reply.status).toBe(502)
    expect(reply.body).toContain('the Ethereum light client is not running')
  })

  it('fails every real name closed while the light client does not run, and says why on the page', async () => {
    const host = await startHost({ ...config(), lightClientOff: 'the Ethereum light client cannot start: the newest checkpoint is 20 days old' }, deps())
    running.push(host)
    const reply = await get(host.port, 'vitalik.eth')
    expect(reply.status).toBe(502)
    expect(reply.body).toContain('Cannot check this site right now')
    expect(reply.body).toContain('the newest checkpoint is 20 days old')
    expect(reply.body).not.toContain('switched off')
    expect(await host.answer({ kind: 'status' })).toEqual({ state: 'off' })
  })

  it('has no provenance for a name it has not mounted', async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    expect(await host.answer({ kind: 'provenance', host: 'other.eth', partition: 'https://other.eth' })).toBeNull()
  })

  it('rejects when the port is taken', async () => {
    const first = await startHost(config(), deps())
    running.push(first)
    await expect(startHost(config({ port: first.port }), deps())).rejects.toThrow(/EADDRINUSE/)
  })
})
