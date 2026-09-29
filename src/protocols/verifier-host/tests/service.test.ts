import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import { buildDag, fakeGateways } from '../../ipfs/tests/dag.test-helpers.js'
import type { FromHost, HostConfig } from '../protocol.js'
import { startHost } from '../service.js'
import { startProtocols } from '../protocols.js'
import { BUILTIN_PROTOCOLS } from '../../builtin.js'
import type { HostDeps, RunningHost } from '../service.js'

const GATEWAY = 'https://a.gateway'
const dag = await buildDag({ 'index.html': '<h1>fixture</h1>' })
const running: RunningHost[] = []
afterEach(() => { for (const host of running.splice(0)) host.server.close() })

function config (overrides: Partial<HostConfig> = {}): HostConfig {
  return { port: 0, lightClient: undefined, gateways: [GATEWAY], unproxiedGateways: [], ccipDirect: false, ipnsNameServices: [], dnsOverHttps: ['https://dns.example/q'], ipnsSequences: {}, fixtures: { 'fixture.eth': `ipfs://${dag.root.toString()}` }, ...overrides }
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
