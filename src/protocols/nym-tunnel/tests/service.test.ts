import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let ups = globalThis.__nymFakeUps ??= { count: 0, failNext: false, options: [] }
let mine = 0
export function initSync () {}
export function main () {}
export async function setupMixTunnel (options) {
  if (ups.failNext) throw new Error('gateway unreachable')
  ups.options.push({ disablePoissonTraffic: options.disablePoissonTraffic, disableCoverTraffic: options.disableCoverTraffic })
  mine = ++ups.count
}
export async function connectTcp (host, port) {
  const sent = []
  return { read: async () => null, write: async (bytes) => { sent.push(bytes) }, close: async () => {} }
}
export async function bindUdp () {
  const inbox = []
  let wake
  let closed = false
  return {
    sendTo: async (host, port, bytes) => {
      const query = Buffer.from(bytes)
      let end = 12
      while (query[end] !== 0) end += query[end] + 1
      const answer = Buffer.concat([Buffer.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]), query.subarray(12, end + 5), Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 7])])
      inbox.push({ data: new Uint8Array(answer), host, port })
      wake?.()
    },
    recv: async () => {
      while (inbox.length === 0) { if (closed) throw new Error('UDP socket closed'); await new Promise((resolve) => { wake = resolve }) }
      return inbox.shift()
    },
    close: () => { closed = true; wake?.() }
  }
}
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
  return { moduleDir: dir, files: [pin(MODULE_GLUE, Buffer.from(glue)), pin(MODULE_WASM, WASM)], port: 0, secret: SECRET, maxInstances: 2, privacy: 'balanced', ...overrides }
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

  it('makes each tunnel at the level the host holds, and a change reaches the tunnels started after it and replaces the idle one now', async () => {
    host = await startHost(await configure({ privacy: 'balanced' }), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    const connect = async (userId: string): Promise<void> => {
      const { socket } = await SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: host?.server.port ?? 0, type: 5, userId, password: SECRET }, command: 'connect', destination: { host: 'service.example', port: 443 } })
      socket.destroy()
    }
    const started = (): unknown[] => (globalThis as { __nymFakeUps?: { options: unknown[] } }).__nymFakeUps?.options ?? []
    await connect('app-one')
    expect(started()).toEqual([{ disablePoissonTraffic: true, disableCoverTraffic: false }])

    host.setPrivacy('strongest')
    await vi.waitFor(() => { expect(host?.instances.snapshot().ready, 'the idle tunnel was closed at once').toBe(0) })
    await connect('app-one')
    expect(started()).toEqual([{ disablePoissonTraffic: true, disableCoverTraffic: false }, { disablePoissonTraffic: false, disableCoverTraffic: false }])

    host.setPrivacy('strongest')
    expect(host.instances.snapshot().ready, 'the same level again replaces nothing').toBe(1)
  })

  it('says which tunnel could not come up, and closes that connection', async () => {
    host = await startHost(await configure(), { post: (message) => { posted.push(message) }, prepare: noGlobals, loader: { importGlue: importGlueNatively } })
    ;(globalThis as { __nymFakeUps?: { count: number, failNext: boolean, options: unknown[] } }).__nymFakeUps = { count: 0, failNext: true, options: [] }
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
