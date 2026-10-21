// An app that talks to a swarm binds a `dgram` socket on every interface and lets the system pick the
// port, sends datagrams to peers its grant names, reads the replies on the same socket, and listens for
// peers with `net.createServer().listen(0)`. This proves those calls through the real shell, over
// loopback: the page's bundled `dgram` and `net` modules, the preload, the broker's grant check and the
// real sockets. A bind on every interface cannot be reached from the network here, so the scope is read
// from the address the socket reports; what it cannot show is named in the catalogue's coverage table.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-network-sockets.test.ts
import { createSocket } from 'node:dgram'
import type { Socket as UdpSocket } from 'node:dgram'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import type { TcpListen, UdpRefusal, UdpRoundTrip } from './network-sockets-entry.js'
import { waitForPageGlobal } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS } from '../support/smoke-helpers.mjs'
import { bundleForApp } from '../node-runtime/pinned-app.js'

const BIND_RANGE = '47000-47100'
const BIND_LOW = 47000
const BIND_HIGH = 47100

interface Echo { readonly socket: UdpSocket, readonly port: number, readonly received: () => number }

async function startEcho (): Promise<Echo> {
  const socket = createSocket('udp4')
  let received = 0
  socket.on('message', (data, rinfo) => { received += 1; socket.send(data, rinfo.port, rinfo.address) })
  await new Promise<void>((resolve) => { socket.bind(0, '127.0.0.1', resolve) })
  return { socket, port: (socket.address() as AddressInfo).port, received: () => received }
}

let app: ElectronApplication
let chrome: Page
let script = ''
const servers: AppServer[] = []
const echoes: Echo[] = []

beforeAll(async () => {
  script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./network-sockets-entry.ts', import.meta.url))))
  const launched = await launchShell()
  app = launched.app
  chrome = launched.chrome
}, 120_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await Promise.all(servers.map(async (server) => { await server.close() }))
  await Promise.all(echoes.map(async (echo) => { await new Promise<void>((resolve) => { echo.socket.close(() => { resolve() }) }) }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Serves the entry on a fresh loopback origin, grants it `grants`, and opens it. */
async function openApp (id: string, capabilities: Parameters<typeof appManifest>[1], grants: Parameters<typeof grantApp>[3]): Promise<Page> {
  const server = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>network sockets</title><body><script src="/app.js"></script></body>' },
    '/app.js': { type: 'text/javascript', body: script }
  })
  servers.push(server)
  await grantApp(app, server.origin, appManifest(id, capabilities), grants)
  const view = await visit(app, chrome, `${server.origin}/`)
  await waitForPageGlobal(view, 'networkSocketsE2e')
  return view
}

interface Entry {
  readonly roundTrip: UdpRoundTrip
  readonly refusal: UdpRefusal
  readonly listenAnywhere: TcpListen
  readonly close: undefined
}

/** Calls `name` on the entry the page's script exposes. The entry runs in the page, so its calls to `window.orivon` carry the page's own frames. */
async function call<K extends keyof Entry> (view: Page, name: K, ...args: readonly unknown[]): Promise<Entry[K]> {
  return await view.evaluate(async ({ method, values }) => {
    const entry = (globalThis as unknown as { networkSocketsE2e: Record<string, (...a: unknown[]) => Promise<unknown>> }).networkSocketsE2e
    return await (entry[method] as (...a: unknown[]) => Promise<unknown>)(...values)
  }, { method: name, values: [...args] }) as Entry[K]
}

it('[app:udp-bind-picks-granted-port] [app:udp-send-reaches-granted-peer] a dgram socket bound with no address and port 0 under a network grant gets a port in the granted range on every interface, sends to the peer the grant names and reads the reply on the same socket', async () => {
  const echo = await startEcho()
  echoes.push(echo)
  const peer = `127.0.0.1:${String(echo.port)}`
  const view = await openApp('udp-network',
    { net: { udp: { bind: { network: [BIND_RANGE] }, send: [peer] } } },
    [{ capability: 'udp.bind.network', patterns: [BIND_RANGE] }, { capability: 'udp.send', patterns: [peer] }])
  const result = await call(view, 'roundTrip', [echo.port], 'ping')
  expect(result.error, JSON.stringify(result)).toBeUndefined()
  expect(result.bound?.address, 'bound on every interface').toBe('0.0.0.0')
  expect(result.bound?.port).toBeGreaterThanOrEqual(BIND_LOW)
  expect(result.bound?.port).toBeLessThanOrEqual(BIND_HIGH)
  expect(result.sendErrors).toEqual([null])
  expect(result.reply).toEqual({ text: 'ping', address: '127.0.0.1', port: echo.port, size: 4 })
  expect(echo.received()).toBe(1)
}, QA_TEST_TIMEOUT_MS)

it('[app:udp-bind-picks-granted-port] [app:udp-send-reaches-granted-peer] with only a local bind grant the same dgram socket is bound on loopback only, inside the granted range, and still sends and receives', async () => {
  const echo = await startEcho()
  echoes.push(echo)
  const peer = `127.0.0.1:${String(echo.port)}`
  const view = await openApp('udp-local',
    { net: { udp: { bind: { local: [BIND_RANGE] }, send: [peer] } } },
    [{ capability: 'udp.bind.local', patterns: [BIND_RANGE] }, { capability: 'udp.send', patterns: [peer] }])
  const result = await call(view, 'roundTrip', [echo.port], 'ping')
  expect(result.error, JSON.stringify(result)).toBeUndefined()
  expect(result.bound?.address, 'asked for every interface, given loopback').toBe('127.0.0.1')
  expect(result.bound?.port).toBeGreaterThanOrEqual(BIND_LOW)
  expect(result.bound?.port).toBeLessThanOrEqual(BIND_HIGH)
  expect(result.reply).toEqual({ text: 'ping', address: '127.0.0.1', port: echo.port, size: 4 })
}, QA_TEST_TIMEOUT_MS)

it('[app:udp-send-outside-grant-is-dropped] a datagram to a host and port the udp.send grant does not name, even beside a *:* pattern, reaches nobody, the socket keeps working, and the raw contract reports the refusal as denied', async () => {
  const granted = await startEcho()
  const ungranted = await startEcho()
  echoes.push(granted, ungranted)
  const peer = `127.0.0.1:${String(granted.port)}`
  const view = await openApp('udp-outside-grant',
    { net: { udp: { bind: { network: [BIND_RANGE] }, send: [peer, '*:*'] } } },
    [{ capability: 'udp.bind.network', patterns: [BIND_RANGE] }, { capability: 'udp.send', patterns: [peer, '*:*'] }])
  // The ungranted send goes first on the same socket, so the reply from the granted peer proves it was handled.
  const result = await call(view, 'roundTrip', [ungranted.port, granted.port], 'ping')
  expect(result.error, JSON.stringify(result)).toBeUndefined()
  expect(result.sendErrors, 'a dropped send is not an error, as with any UDP send').toEqual([null, null])
  expect(result.reply?.port, 'the reply came from the granted peer').toBe(granted.port)
  await new Promise<void>((resolve) => { setTimeout(resolve, ABSENCE_SETTLE_MS) })
  expect(ungranted.received(), 'nothing reached the peer the grant does not name').toBe(0)
  expect(granted.received()).toBe(1)

  const refusal = await call(view, 'refusal', ungranted.port)
  expect(refusal.error, JSON.stringify(refusal)).toBeUndefined()
  expect(refusal.refusal).toEqual({ address: '127.0.0.1', port: ungranted.port, code: 'denied' })
  await new Promise<void>((resolve) => { setTimeout(resolve, ABSENCE_SETTLE_MS) })
  expect(ungranted.received(), 'the raw write reached nobody either').toBe(0)
}, QA_TEST_TIMEOUT_MS)

it('[app:tcp-listen-any-interface-accepts-connections] net.createServer().listen(0) with no host under a network listen grant gets a port in the granted range on every interface and accepts a connection from another program', async () => {
  const view = await openApp('tcp-network',
    { net: { tcp: { listen: { network: [BIND_RANGE] } } } },
    [{ capability: 'tcp.listen.network', patterns: [BIND_RANGE] }])
  const listening = await call(view, 'listenAnywhere')
  expect(listening.error, JSON.stringify(listening)).toBeUndefined()
  expect(listening.address?.address, 'listening on every interface').toBe('0.0.0.0')
  const port = listening.address?.port ?? 0
  expect(port).toBeGreaterThanOrEqual(BIND_LOW)
  expect(port).toBeLessThanOrEqual(BIND_HIGH)
  const greeting = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.once('end', () => { resolve(text) })
    socket.once('error', reject)
  })
  expect(greeting).toBe('hello from the page')
  await call(view, 'close')
}, QA_TEST_TIMEOUT_MS)
