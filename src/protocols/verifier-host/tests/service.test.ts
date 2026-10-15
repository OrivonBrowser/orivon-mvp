import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:https'
import { buildDag, fakeGateways } from '../../ipfs/tests/dag.test-helpers.js'
import type { FromHost, HostConfig } from '../protocol.js'
import { startHost } from '../service.js'
import { startProtocols } from '../protocols.js'
import { partitionStoreKey } from '../partition-key.js'
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
    routedFetch: async () => { throw new Error('no routed fetch in this test') },
    ...overrides
  }
}

async function get (port: number, host: string, path = '/', partition = `https://${host}`, extra: Record<string, string> = {}): Promise<{ status: number, body: string, location?: string | undefined }> {
  return await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host, 'x-orivon-partition': partition, ...extra } }, (res) => {
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

  describe('when the endpoint is the node Orivon runs', () => {
    it('asks main for the node before it mounts, and serves once main says it is ready', async () => {
      const { site, swarm } = await swarmWorld()
      const world = deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) })
      const { posted } = world
      const host = await startHost(config({ swarmEndpoints: [ENDPOINT], swarmNode: true }), world)
      running.push(host)
      const cid = referenceCid(site)
      const page = get(host.port, `${cid}.bzz.orivon`)
      await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'node-wanted', node: 'swarm-node' }) })
      expect(swarm.requests).toEqual([])
      host.node({ type: 'node', node: 'swarm-node', state: 'ready' })
      expect(await page).toEqual({ status: 200, body: '<h1>on swarm</h1>' })
    })

    it('reports a .eth name as a bzz name as soon as Swarm is chosen for it, before the node is ready or any chunk is read', async () => {
      const { site, swarm } = await swarmWorld()
      const world = deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) })
      const { posted } = world
      const host = await startHost(config({ swarmEndpoints: [ENDPOINT], swarmNode: true, fixtures: { 'swarm.eth': `bzz://${site}` } }), world)
      running.push(host)
      const page = get(host.port, 'swarm.eth')
      await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'name-scheme', host: 'swarm.eth', scheme: 'bzz' }) })
      expect(swarm.requests).toEqual([])
      host.node({ type: 'node', node: 'swarm-node', state: 'ready' })
      expect(await page).toEqual({ status: 200, body: '<h1>on swarm</h1>' })
    })

    it('shows the reason in plain words, and asks no endpoint, when main says the node is off', async () => {
      const { site, swarm } = await swarmWorld()
      const world = deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) })
      const { posted } = world
      const host = await startHost(config({ swarmEndpoints: [ENDPOINT], swarmNode: true }), world)
      running.push(host)
      const page = get(host.port, `${referenceCid(site)}.bzz.orivon`)
      await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'node-wanted', node: 'swarm-node' }) })
      host.node({ type: 'node', node: 'swarm-node', state: 'off', reason: 'the Swarm node is not installed' })
      const answered = await page
      expect(answered.status).toBe(502)
      expect(answered.body).toContain('the Swarm node is not installed')
      expect(swarm.requests).toEqual([])
    })

    it('never asks main for a node when the endpoint is not one', async () => {
      const { site, swarm } = await swarmWorld()
      const world = deps({ fetch: async (url, init) => await swarm.fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal }) })
      const { posted } = world
      const host = await startHost(config({ swarmEndpoints: [ENDPOINT] }), world)
      running.push(host)
      expect((await get(host.port, `${referenceCid(site)}.bzz.orivon`)).status).toBe(200)
      expect(posted).not.toContainEqual({ type: 'node-wanted', node: 'swarm-node' })
    })
  })
})

/** A page the person is looking at, and a link on it that the person pressed. */
const DOCUMENT = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const PRESS = { 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' }

describe('startHost with the IPFS node', () => {
  const NODE = 'http://127.0.0.1:20123'
  const SALT = 'ab'.repeat(32)
  const NODE_CONFIG = { endpoint: NODE, partitionSalt: SALT, lookupService: true }

  function world () {
    const gw = fakeGateways(dag.blocks)
    const made = deps({ fetch: async (url, init) => await gw.fetch(url, { headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? new AbortController().signal }) })
    return { gw, made, posted: made.posted }
  }

  const provenanceOf = async (host: RunningHost): Promise<unknown> => await host.answer({ kind: 'provenance', host: 'fixture.eth', partition: 'https://fixture.eth' })

  it('asks main for the node first, reads only the node once it is ready, and says so', async () => {
    const { gw, made, posted } = world()
    const host = await startHost(config({ ipfsNode: NODE_CONFIG }), made)
    running.push(host)
    const page = get(host.port, 'fixture.eth')
    await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'node-wanted', node: 'ipfs-node' }) })
    expect(gw.requests).toEqual([])
    host.node({ type: 'node', node: 'ipfs-node', state: 'ready' })
    expect(await page).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(gw.requests.length).toBeGreaterThan(0)
    expect(gw.requests.every((url) => url.startsWith(`${NODE}/`))).toBe(true)
    expect(await provenanceOf(host)).toMatchObject({ servedFrom: { kind: 'node' } })
  })

  it('reads no gateway, and offers one, when the node cannot run; the person\'s yes loads this site through them and says why', async () => {
    const { gw, made, posted } = world()
    const host = await startHost(config({ ipfsNode: NODE_CONFIG }), made)
    running.push(host)
    const page = get(host.port, 'fixture.eth', '/', undefined, DOCUMENT)
    await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'node-wanted', node: 'ipfs-node' }) })
    host.node({ type: 'node', node: 'ipfs-node', state: 'off', reason: 'a proxy is configured' })
    const refused = await page
    expect(refused.status).toBe(502)
    expect(refused.body).toContain('a proxy is configured')
    expect(refused.body).toContain('Load through public gateways')
    expect(gw.requests).toEqual([])
    const href = /id="load-through-gateways" href="([^"]+)"/.exec(refused.body)?.[1]?.replaceAll('&#38;', '&')
    expect(href).toMatch(/^\/\.orivon\/load-through-gateways\?token=/)
    const accepted = await get(host.port, 'fixture.eth', href, undefined, { ...PRESS })
    expect(accepted).toMatchObject({ status: 303, location: '/' })
    // The way back is a path on this site and nothing else: another host, a backslash and the host's own paths all come back to the root.
    const token = /token=([^&]+)/.exec(href ?? '')?.[1] ?? ''
    for (const to of ['//evil.example/', '/\\evil.example', '/.orivon/load-through-gateways', 'https://evil.example/']) {
      const back = await get(host.port, 'fixture.eth', `/.orivon/load-through-gateways?token=${token}&to=${encodeURIComponent(to)}`, undefined, { ...PRESS })
      expect(back).toMatchObject({ status: 303, location: '/' })
    }
    // The press asked for the gateways: the load that follows reads them at once, without asking the node again.
    const again = get(host.port, 'fixture.eth', '/', undefined, DOCUMENT)
    expect(await again).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    expect(gw.requests.every((url) => url.startsWith(`${GATEWAY}/`))).toBe(true)
    expect(await provenanceOf(host)).toMatchObject({ servedFrom: { kind: 'gateways', reason: expect.stringContaining('you loaded this page through them') } })
    // The page's own files are read from the site that was loaded, without asking again.
    expect((await get(host.port, 'fixture.eth', '/index.html')).status).toBe(200)
    // The yes was for that load: the next page load of the site asks again.
    const asks = posted.filter((message) => message.type === 'node-wanted').length
    const next = get(host.port, 'fixture.eth', '/', undefined, DOCUMENT)
    await vi.waitFor(() => { expect(posted.filter((message) => message.type === 'node-wanted').length).toBeGreaterThan(asks) })
    host.node({ type: 'node', node: 'ipfs-node', state: 'off', reason: 'a proxy is configured' })
    const asked = await next
    expect(asked.status).toBe(502)
    expect(asked.body).toContain('Load through public gateways')
  })

  it('offers the gateways too when the node served the site\'s root and then could not give its page', async () => {
    const gw = fakeGateways(dag.blocks)
    const posted: FromHost[] = []
    const made = deps({
      post: (message) => { posted.push(message) },
      // The node has the root block and nothing under it.
      fetch: async (url, init) => url.includes(dag.root.toString()) ? await gw.fetch(url, { headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal ?? new AbortController().signal }) : new Response('not here', { status: 404 })
    })
    const host = await startHost(config({ ipfsNode: { ...NODE_CONFIG, retryWaitMs: 20 } }), made)
    running.push(host)
    const page = get(host.port, 'fixture.eth', '/', undefined, DOCUMENT)
    await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'node-wanted', node: 'ipfs-node' }) })
    host.node({ type: 'node', node: 'ipfs-node', state: 'ready' })
    const answer = await page
    expect(answer.status).toBeGreaterThanOrEqual(404)
    expect(answer.body).toContain('Load through public gateways')
  })

  it('does not take one site\'s yes for another site\'s load, nor a yes without the page\'s own token', async () => {
    const { gw, made, posted } = world()
    const host = await startHost(config({ ipfsNode: NODE_CONFIG }), made)
    running.push(host)
    const first = get(host.port, 'fixture.eth', '/', undefined, DOCUMENT)
    await vi.waitFor(() => { expect(posted).toContainEqual({ type: 'node-wanted', node: 'ipfs-node' }) })
    host.node({ type: 'node', node: 'ipfs-node', state: 'off', reason: 'off' })
    const href = /id="load-through-gateways" href="([^"]+)"/.exec((await first).body)?.[1]?.replaceAll('&#38;', '&') ?? ''
    // The token is for this site's page: another page cannot use it, and a request that is not a navigation cannot follow it.
    expect((await get(host.port, 'fixture.eth', href, 'https://other.eth', { ...PRESS })).status).toBe(403)
    expect((await get(host.port, 'fixture.eth', href)).status).toBe(403)
    // A navigation the person did not start (a script's) is refused even with the page's own token.
    expect((await get(host.port, 'fixture.eth', href, undefined, { 'sec-fetch-mode': 'navigate' })).status).toBe(403)
    expect((await get(host.port, 'fixture.eth', '/.orivon/load-through-gateways?token=forged', undefined, { ...PRESS })).status).toBe(403)
    const asks = posted.filter((message) => message.type === 'node-wanted').length
    const other = get(host.port, 'fixture.eth', '/', 'https://other.eth', DOCUMENT)
    await vi.waitFor(() => { expect(posted.filter((message) => message.type === 'node-wanted').length).toBeGreaterThan(asks) })
    host.node({ type: 'node', node: 'ipfs-node', state: 'off', reason: 'off' })
    expect((await other).status).toBe(502)
    expect(gw.requests).toEqual([])
  })

  it('reads from the gateways, as before, when no node is chosen, and never asks for one', async () => {
    const { gw, made, posted } = world()
    const host = await startHost(config(), made)
    running.push(host)
    expect((await get(host.port, 'fixture.eth')).status).toBe(200)
    expect(posted).not.toContainEqual({ type: 'node-wanted', node: 'ipfs-node' })
    expect(gw.requests.every((url) => url.startsWith(`${GATEWAY}/`))).toBe(true)
    expect(await provenanceOf(host)).toMatchObject({ servedFrom: { kind: 'gateways' } })
    expect(await provenanceOf(host)).not.toHaveProperty('servedFrom.reason')
  })
})

describe('startHost with the IPFS node, one store for every site', () => {
  const NODE = 'http://127.0.0.1:20123'
  const SALT = 'ab'.repeat(32)
  const ASKED_FOR = (partition: string): string => partitionStoreKey(SALT, partition)

  /** Every request the node got, with the partition header it carried. */
  function recording () {
    const gw = fakeGateways(dag.blocks)
    const asked: Array<{ url: string, header: string | undefined }> = []
    const made = deps({
      fetch: async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        asked.push({ url, header: headers['x-orivon-partition'] })
        return await gw.fetch(url, { headers, signal: init?.signal ?? new AbortController().signal })
      }
    })
    return { asked, made }
  }

  async function started () {
    const { asked, made } = recording()
    const host = await startHost(config({ ipfsNode: { endpoint: NODE, partitionSalt: SALT, lookupService: true } }), made)
    running.push(host)
    host.node({ type: 'node', node: 'ipfs-node', state: 'ready' })
    return { asked, host }
  }

  it('keys each partition\'s reads by a hash of the salt and the partition, never the origin itself', async () => {
    const { asked, host } = await started()
    expect((await get(host.port, 'fixture.eth', '/', 'https://target.eth')).status).toBe(200)
    const keys = new Set(asked.map((request) => request.header))
    expect(keys).toEqual(new Set([ASKED_FOR('https://target.eth')]))
    expect([...keys][0]).toHaveLength(43)
    expect(JSON.stringify(asked)).not.toContain('target.eth')
  })

  it('sends another partition\'s reads under another key, so the node keeps what each fetched apart', async () => {
    const { asked, host } = await started()
    await get(host.port, 'fixture.eth', '/', 'https://one.eth')
    await get(host.port, 'fixture.eth', '/', 'https://two.eth')
    const byKey = (key: string): number => asked.filter((request) => request.header === key).length
    expect(byKey(ASKED_FOR('https://one.eth'))).toBeGreaterThan(0)
    expect(byKey(ASKED_FOR('https://two.eth'))).toBeGreaterThan(0)
    expect(ASKED_FOR('https://one.eth')).not.toBe(ASKED_FOR('https://two.eth'))
  })

  it('keys a key by the salt: another profile\'s salt gives the same partition another key', () => {
    expect(partitionStoreKey('cd'.repeat(32), 'https://one.eth')).not.toBe(ASKED_FOR('https://one.eth'))
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
