import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import { buildDag, fakeGateways } from '../../ipfs/tests/dag.test-helpers.js'
import type { FromHost, HostConfig } from '../protocol.js'
import { startHost } from '../service.js'
import type { HostDeps, RunningHost } from '../service.js'

const GATEWAY = 'https://a.gateway'
const dag = await buildDag({ 'index.html': '<h1>fixture</h1>' })
const running: RunningHost[] = []
afterEach(() => { for (const host of running.splice(0)) host.server.close() })

function config (overrides: Partial<HostConfig> = {}): HostConfig {
  return { port: 0, lightClient: undefined, gateways: [GATEWAY], ipnsNameServices: [], dnsOverHttps: ['https://dns.example/q'], ipnsSequences: {}, fixtures: { 'fixture.eth': `ipfs://${dag.root.toString()}` }, ...overrides }
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
    ...overrides
  }
}

async function get (port: number, host: string, path = '/'): Promise<{ status: number, body: string }> {
  return await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, servername: host, rejectUnauthorized: false, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    }).on('error', reject).end()
  })
}

describe('startHost', () => {
  it('serves a fixture name from IPFS through the loopback server, and reports its provenance', async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    expect(host.fingerprint).toMatch(/^sha256\//)
    expect(await get(host.port, 'fixture.eth')).toEqual({ status: 200, body: '<h1>fixture</h1>' })
    const provenance = await host.answer({ kind: 'provenance', host: 'fixture.eth' })
    expect(provenance).toMatchObject({ host: 'fixture.eth', resolver: 'fixture', root: { kind: 'ipfs', cid: dag.root.toString() }, ddoc: { status: 'met' } })
  })

  it('refuses fixture names unless the build allows them, failing closed like any unverifiable name', async () => {
    const host = await startHost(config(), deps({ fixturesAllowed: false }))
    running.push(host)
    const reply = await get(host.port, 'fixture.eth')
    expect(reply.status).toBe(502)
    expect(reply.body).toContain('switched off')
  })

  it('fails every real name closed while the light client is switched off, and says so', async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    expect((await get(host.port, 'vitalik.eth')).status).toBe(502)
    expect(await host.answer({ kind: 'status' })).toEqual({ state: 'off' })
  })

  it('has no provenance for a name it has not mounted', async () => {
    const host = await startHost(config(), deps())
    running.push(host)
    expect(await host.answer({ kind: 'provenance', host: 'other.eth' })).toBeNull()
  })

  it('rejects when the port is taken', async () => {
    const first = await startHost(config(), deps())
    running.push(first)
    await expect(startHost(config({ port: first.port }), deps())).rejects.toThrow(/EADDRINUSE/)
  })
})
