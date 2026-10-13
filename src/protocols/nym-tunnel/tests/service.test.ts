import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SocksClient } from 'socks'
import { installModuleGlobals, startHost } from '../service.js'
import type { RunningHost } from '../service.js'
import { MODULE_GLUE, MODULE_WASM } from '../protocol.js'
import type { FromHost, NymTunnelConfig, PinnedFile } from '../protocol.js'
import type { ModuleNetwork } from '../module-net.js'

const SECRET = 'service-test-secret'
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

/** A module with the exports the real one has, whose tunnels "connect" to nothing and count what happens. */
const FAKE_GLUE = `
let ups = globalThis.__nymFakeUps ??= { count: 0, failNext: false }
let mine = 0
export function initSync () {}
export function main () {}
export async function setupMixTunnel (options) {
  if (ups.failNext) throw new Error('gateway unreachable')
  mine = ++ups.count
}
export async function connectTcp (host, port) {
  const sent = []
  return { read: async () => null, write: async (bytes) => { sent.push(bytes) }, close: async () => {} }
}
export async function bindUdp () { throw new Error('not in this fake') }
export async function disconnectMixTunnel () {}
`

let dir = ''
let host: RunningHost | undefined
const posted: FromHost[] = []

function pin (name: string, bytes: Buffer): PinnedFile {
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Each test's glue has its own text: a module imported from a `data:` URL is cached by the URL, so the same text would be one instance for the whole file. */
async function configure (overrides: Partial<NymTunnelConfig> = {}, source = FAKE_GLUE): Promise<NymTunnelConfig> {
  const glue = `${source}\n// ${Math.random().toString(36)}`
  await writeFile(join(dir, MODULE_GLUE), glue)
  await writeFile(join(dir, MODULE_WASM), WASM)
  return { moduleDir: dir, files: [pin(MODULE_GLUE, Buffer.from(glue)), pin(MODULE_WASM, WASM)], port: 0, secret: SECRET, maxInstances: 2, ...overrides }
}

const noGlobals = async (): Promise<void> => {}
const importGlueNatively = async (source: Buffer): Promise<unknown> => await import(/* @vite-ignore */ `data:text/javascript;base64,${source.toString('base64')}`)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-nym-service-'))
  posted.length = 0
  delete (globalThis as { __nymFakeUps?: unknown }).__nymFakeUps
})

afterEach(async () => {
  await host?.stop()
  host = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('the Nym tunnel host', () => {
  it('listens once the module is loaded, and brings up a tunnel for the first connection of a user name', async () => {
    host = await startHost(await configure(), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    expect(posted).toContainEqual({ type: 'listening' })
    const { socket } = await SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: host.server.port, type: 5, userId: 'app-one', password: SECRET }, command: 'connect', destination: { host: 'service.example', port: 443 } })
    socket.destroy()
    const snapshots = posted.filter((message) => message.type === 'instances')
    expect(snapshots.some((message) => message.type === 'instances' && message.connecting === 1)).toBe(true)
    expect(snapshots.at(-1)).toMatchObject({ type: 'instances', ready: 1, connecting: 0 })
    expect((globalThis as { __nymFakeUps?: { count: number } }).__nymFakeUps?.count).toBe(1)
  })

  it('keeps a tunnel for each user name', async () => {
    host = await startHost(await configure(), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    for (const userId of ['app-one', 'app-two']) {
      const { socket } = await SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: host.server.port, type: 5, userId, password: SECRET }, command: 'connect', destination: { host: 'service.example', port: 443 } })
      socket.destroy()
    }
    expect(host.instances.snapshot().ready).toBe(2)
  })

  it('says which tunnel could not come up, and closes that connection', async () => {
    host = await startHost(await configure(), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    ;(globalThis as { __nymFakeUps?: { count: number, failNext: boolean } }).__nymFakeUps = { count: 0, failNext: true }
    await expect(SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: host.server.port, type: 5, userId: 'app-one', password: SECRET }, command: 'connect', destination: { host: 'service.example', port: 443 } })).rejects.toThrow()
    const last = posted.filter((message) => message.type === 'instances').at(-1)
    expect(last).toMatchObject({ type: 'instances', ready: 0, connecting: 0 })
    expect(last?.type === 'instances' ? last.problem : '').toContain('gateway unreachable')
  })

  it('refuses to start from files that are not the pinned ones, before listening', async () => {
    const config = await configure()
    await writeFile(join(dir, MODULE_GLUE), `${FAKE_GLUE}\n// changed`)
    await expect(startHost(config, { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })).rejects.toThrow()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ type: 'failed', stage: 'artifact' })
  })

  it('refuses a glue that is not the module', async () => {
    const config = await configure({}, 'export const nothing = 1\n')
    await expect(startHost(config, { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })).rejects.toThrow()
    expect(posted[0]).toMatchObject({ type: 'failed', stage: 'artifact' })
  })

  it('says when its port is taken', async () => {
    const first = await startHost(await configure(), { post: () => {}, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    try {
      await expect(startHost(await configure({ port: first.server.port }), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })).rejects.toThrow()
      expect(posted.at(-1)).toMatchObject({ type: 'failed', stage: 'listen' })
    } finally {
      await first.stop()
    }
  })

  it('accepts only the secret: a connection that sends another gets no tunnel', async () => {
    host = await startHost(await configure(), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    await expect(SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: host.server.port, type: 5, userId: 'app-one', password: 'other' }, command: 'connect', destination: { host: 'service.example', port: 443 } })).rejects.toThrow()
    expect((globalThis as { __nymFakeUps?: { count: number } }).__nymFakeUps?.count ?? 0).toBe(0)
    const raw = netConnect(host.server.port, '127.0.0.1')
    raw.on('error', () => {})
    raw.destroy()
  })
})

describe('the globals the module needs', () => {
  it('makes self, a WorkerGlobalScope in the prototype chain, and the checked fetch and WebSocket', async () => {
    const target = {} as typeof globalThis
    const network: ModuleNetwork = { fetch: (async () => new Response('x')) as typeof fetch, WebSocket: class {} as unknown as typeof WebSocket }
    await installModuleGlobals(target, network)
    expect((target as unknown as { self: unknown }).self).toBe(target)
    expect(target instanceof (target as unknown as { WorkerGlobalScope: new () => object }).WorkerGlobalScope).toBe(true)
    expect(target.fetch).toBe(network.fetch)
    expect(target.WebSocket).toBe(network.WebSocket)
    expect(typeof indexedDB).toBe('object')
  })
})
