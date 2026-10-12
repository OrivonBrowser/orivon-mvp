// An installed app the person routed through a SOCKS5 proxy sends nothing anywhere else. The fixture app is served
// from the loader's cache (the only kind of app with a session of its own), its proxy is a SOCKS5 fixture that
// knows the names the app uses and nothing on this machine does, and every name the app dials has a decoy listening
// on the same port on loopback: this machine answers an unknown name with a loopback address, so a dial that skipped
// the proxy would land on a decoy, and a decoy that counts a connection fails the test.
//
// The app turns its route on from the Settings page, as a person does, and then dials by name (`orivon.net.connect`,
// `connectSecure`, a datagram, a WebSocket), has an image loaded from a granted https host (the loader's reach path)
// and shows a page in a <webview> (Chromium's own network stack, through the app's loopback front). Every one must
// show up in the SOCKS log and answer. What the route cannot carry is refused, and with the proxy stopped nothing
// answers and nothing arrives anywhere else.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-routed-network.test.ts
import { execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import type { Socket as UdpSocket } from 'node:dgram'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, waitForPageGlobal } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'
import type { Attempt } from './routed-network-entry.js'

const ORIGIN = 'https://routed-network-e2e.orivon.test'
const SETTINGS_URL_PREFIX = 'orivon://settings'
const ROUTE_SWITCH = '.app-card:has-text("routed-network-e2e") .app-route .switch'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A TCP server that counts what reaches it and remembers when each connection ended. */
interface Counting { readonly port: number, readonly connections: () => number, readonly closed: () => number, readonly close: () => Promise<void> }

async function counting (onConnection?: (socket: Socket) => void): Promise<Counting> {
  const open = new Set<Socket>()
  let connections = 0
  let closed = 0
  const server: Server = createTcpServer((socket) => {
    connections += 1
    open.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => { open.delete(socket); closed += 1 })
    onConnection?.(socket)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    closed: () => closed,
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

async function udpCounting (reply = false): Promise<{ port: number, hits: () => number, close: () => void }> {
  const socket: UdpSocket = createSocket('udp4')
  let hits = 0
  socket.on('message', (data, from) => { hits += 1; if (reply) socket.send(data, from.port, from.address) })
  await new Promise<void>((resolve) => { socket.bind(0, '127.0.0.1', resolve) })
  return { port: socket.address().port, hits: () => hits, close: () => { socket.close() } }
}

/** A self-signed certificate for the names the app dials over TLS, trusted by the main process through NODE_EXTRA_CA_CERTS. */
function certificate (dir: string, names: readonly string[]): { cert: string, key: string, path: string } {
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${names[0] ?? 'localhost'}`, '-addext', `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`, '-keyout', key, '-out', cert, '-days', '1'], { stdio: 'pipe' })
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8'), path: cert }
}

let dir: string
let socks: Socks5Fixture
let secondSocks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let view: Page
let script = ''
const cleanups: Array<() => Promise<void> | void> = []

/** Logical ports: every one is a port a decoy holds on loopback, and the SOCKS fixture maps the app's name:port to a real server elsewhere. */
const ports = { tcp: 0, tls: 0, ws: 0, embed: 0, reach: 0, udp: 0, hold: 0, listen: 0 }
const decoys: Counting[] = []
let udpDecoy: Awaited<ReturnType<typeof udpCounting>>
let stunDecoy: Awaited<ReturnType<typeof udpCounting>>
let holdDecoy: Counting

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-routed-e2e-'))
  const names = ['tls.socks.test', 'reach.socks.test']
  const tls = certificate(dir, names)

  // Decoys first: their ports are the ones the app is told.
  for (const name of ['tcp', 'tls', 'ws', 'embed', 'reach'] as const) {
    const decoy = await counting()
    decoys.push(decoy)
    ports[name] = decoy.port
  }
  holdDecoy = await counting((socket) => { socket.on('data', (chunk) => socket.write(chunk)) })
  ports.hold = holdDecoy.port
  const listenProbe = await counting()
  ports.listen = listenProbe.port
  await listenProbe.close()
  udpDecoy = await udpCounting()
  ports.udp = udpDecoy.port
  stunDecoy = await udpCounting()

  // The real servers, which only the SOCKS fixture can name.
  const echo = await counting((socket) => { socket.on('data', (chunk) => socket.write(chunk)) })
  const hello = createTlsServer({ key: tls.key, cert: tls.cert }, (socket) => { socket.on('error', () => {}); socket.end('hello over tls') })
  hello.on('tlsClientError', () => {})
  await new Promise<void>((resolve) => { hello.listen(0, '127.0.0.1', resolve) })
  const websockets = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => { websockets.on('listening', resolve) })
  websockets.on('connection', (socket) => { socket.send('hello over websocket') })
  const page = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>shown through the front</title><body>shown</body>') })
  await new Promise<void>((resolve) => { page.listen(0, '127.0.0.1', resolve) })
  const images = createHttpsServer({ key: tls.key, cert: tls.cert }, (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG) })
  await new Promise<void>((resolve) => { images.listen(0, '127.0.0.1', resolve) })
  const udpReal = await udpCounting(true)

  const local = (port: number): { host: string, port: number } => ({ host: '127.0.0.1', port })
  const fixtureOptions = {
    preferAuth: true,
    names: {
      [`tcp.socks.test:${String(ports.tcp)}`]: local(echo.port),
      [`tls.socks.test:${String(ports.tls)}`]: local((hello.address() as AddressInfo).port),
      [`ws.socks.test:${String(ports.ws)}`]: local((websockets.address() as AddressInfo).port),
      [`embed.socks.test:${String(ports.embed)}`]: local((page.address() as AddressInfo).port),
      [`reach.socks.test:${String(ports.reach)}`]: local((images.address() as AddressInfo).port),
      [`udp.socks.test:${String(ports.udp)}`]: local(udpReal.port)
    }
  }
  socks = await startSocks5Fixture(fixtureOptions)
  secondSocks = await startSocks5Fixture(fixtureOptions)

  script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./routed-network-entry.ts', import.meta.url))))

  cleanups.push(
    async () => { for (const decoy of decoys) await decoy.close() },
    async () => { await holdDecoy.close() },
    async () => { await echo.close() },
    () => { udpDecoy.close(); stunDecoy.close(); udpReal.close() },
    async () => { await new Promise<void>((resolve) => { hello.close(() => { resolve() }) }) },
    async () => { await new Promise<void>((resolve) => { websockets.close(() => { resolve() }) }) },
    async () => { await new Promise<void>((resolve) => { page.close(() => { resolve() }); page.closeAllConnections() }) },
    async () => { await new Promise<void>((resolve) => { images.close(() => { resolve() }); images.closeAllConnections() }) },
    async () => { await secondSocks.close() },
    () => { rmSync(dir, { recursive: true, force: true }) }
  )

  // The profile names the proxy; no app is routed yet.
  const launched = await launchShell({
    env: { NODE_EXTRA_CA_CERTS: tls.path },
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
  app = launched.app
  chrome = launched.chrome

  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.behaviour.routed-network',
    name: 'Behaviour routed-network',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: {
      net: {
        tcp: { connect: [`tcp.socks.test:${String(ports.tcp)}`, `ws.socks.test:${String(ports.ws)}`, `127.0.0.1:${String(ports.hold)}`, `127.0.0.1:${String(ports.listen)}`], listen: { local: [String(ports.listen)] } },
        https: { connect: [`tls.socks.test:${String(ports.tls)}`, `reach.socks.test:${String(ports.reach)}`] },
        udp: { bind: { local: ['47300-47399'] }, send: [`udp.socks.test:${String(ports.udp)}`] }
      },
      web: { embed: { origins: [`http://embed.socks.test:${String(ports.embed)}`] } }
    }
  }
  const served = await serveApp(app, ORIGIN, manifest, 'tcp.connect', {
    '/index.html': new TextEncoder().encode('<!doctype html><title>routed network</title><body><script src="/app.js"></script></body>'),
    '/app.js': new TextEncoder().encode(script)
  }, manifest.capabilities.net?.tcp?.connect ?? [], [
    { capability: 'tcp.listen.local', patterns: [String(ports.listen)] },
    { capability: 'https.connect', patterns: manifest.capabilities.net?.https?.connect ?? [] },
    { capability: 'udp.bind.local', patterns: ['47300-47399'] },
    { capability: 'udp.send', patterns: [`udp.socks.test:${String(ports.udp)}`] },
    { capability: 'web.embed', patterns: [`http://embed.socks.test:${String(ports.embed)}`] }
  ])
  expect(served).toEqual({ granted: true, registered: true })
  view = await openApp()
}, 180_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await socks.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openApp (): Promise<Page> {
  await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
  expect((await waitForTab(chrome, { address: `${ORIGIN}/` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, `${ORIGIN}/`) !== undefined)).toBe(true)
  const page = findViewShowing(app, chrome, `${ORIGIN}/`) as Page
  await page.waitForLoadState('load')
  await waitForPageGlobal(page, 'routedNetworkE2e')
  return page
}

interface Entry {
  tcp: (host: string, port: number) => Attempt
  secure: (host: string, port: number) => Attempt
  datagram: (host: string, port: number) => Attempt
  webSocket: (url: string) => Attempt
  image: (url: string) => Attempt
  embed: (url: string) => Attempt
  listen: (scope: 'local' | 'network') => Attempt
  loopback: (port: number) => Attempt
  lookup: (hostname: string) => Attempt
  candidates: (stunPort: number) => Attempt
  hold: (host: string, port: number) => Attempt
  heldState: () => Attempt
}

/** Calls `name` on the entry the page's script exposes; the entry runs in the page, so its calls to `window.orivon` carry the page's own frames. */
async function call<K extends keyof Entry> (name: K, ...args: readonly unknown[]): Promise<Attempt> {
  return await view.evaluate(async ({ method, values }) => {
    const entry = (globalThis as unknown as { routedNetworkE2e: Record<string, (...a: unknown[]) => Promise<unknown>> }).routedNetworkE2e
    return await (entry[method] as (...a: unknown[]) => Promise<unknown>)(...values)
  }, { method: name, values: [...args] }) as Attempt
}

async function openSettings (section: 'apps' | 'privacy'): Promise<Page> {
  await chrome.evaluate((path) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', path) }, `/${section}`)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(SETTINGS_URL_PREFIX)))).toBe(true)
  return app.windows().find((w) => w.url().startsWith(SETTINGS_URL_PREFIX)) as Page
}

const dialed = (fixture: Socks5Fixture, name: string, port: number): boolean =>
  fixture.requests.some((request) => request.destination === name && request.port === port && request.addressType === 'domain')

const directHits = (): number => decoys.reduce((total, decoy) => total + decoy.connections(), 0) + udpDecoy.hits()

it('[app:routed-app-sends-nothing-direct] an installed app switched on in Settings dials by name, over TLS, by datagram and by WebSocket, loads an image from a granted host and shows a page in a <webview>, all through its proxy and nothing anywhere else', async () => {
  // Before the route: the browser's own WebRTC reaches a STUN server directly, so the probe below can see a leak.
  const before = await call('candidates', stunDecoy.port)
  expect(Number(before.detail), 'a control: unrouted, the page gathers candidates and talks UDP').toBeGreaterThan(0)
  expect(stunDecoy.hits()).toBeGreaterThan(0)
  const held = await call('hold', '127.0.0.1', ports.hold)
  expect(held.ok, JSON.stringify(held)).toBe(true)
  expect(await waitFor(() => holdDecoy.connections() === 1)).toBe(true)

  // The switch on the app's card in Settings, as a person turns it on.
  const settings = await openSettings('apps')
  await settings.waitForSelector(ROUTE_SWITCH)
  await settings.locator(ROUTE_SWITCH).click()
  // The app's tab is reloaded when the switch flips, and what it held open is closed.
  expect(await waitFor(() => holdDecoy.closed() === 1), 'the connection the app held open before the switch is closed').toBe(true)
  await view.waitForLoadState('load')
  await waitForPageGlobal(view, 'routedNetworkE2e')
  stunDecoy.close()
  stunDecoy = await udpCounting()

  const tcp = await call('tcp', 'tcp.socks.test', ports.tcp)
  expect(tcp, 'connect by name').toMatchObject({ ok: true, detail: 'ping' })
  const secure = await call('secure', 'tls.socks.test', ports.tls)
  expect(secure, 'connectSecure by name').toMatchObject({ ok: true, detail: 'hello over tls' })
  const datagram = await call('datagram', 'udp.socks.test', ports.udp)
  expect(datagram, 'a datagram by name').toMatchObject({ ok: true, detail: 'ping' })
  const socket = await call('webSocket', `ws://ws.socks.test:${String(ports.ws)}/`)
  expect(socket, 'a WebSocket').toMatchObject({ ok: true, detail: 'hello over websocket' })
  const picture = await call('image', `https://reach.socks.test:${String(ports.reach)}/x.png`)
  expect(picture, 'the loader\'s reach path').toMatchObject({ ok: true, detail: '1x1' })
  const shown = await call('embed', `http://embed.socks.test:${String(ports.embed)}/`)
  expect(shown, 'Chromium\'s own stack, through the front').toMatchObject({ ok: true, detail: 'shown through the front' })

  for (const [name, port] of [['tcp.socks.test', ports.tcp], ['tls.socks.test', ports.tls], ['ws.socks.test', ports.ws], ['reach.socks.test', ports.reach], ['embed.socks.test', ports.embed]] as const) {
    expect(dialed(socks, name, port), `${name}:${String(port)} was asked of the proxy`).toBe(true)
  }
  expect(socks.datagrams).toContain(`udp.socks.test:${String(ports.udp)}`)
  const signedIn = socks.requests.filter((request) => request.userId !== undefined)
  expect(signedIn.length, 'the proxy was signed in to with a user name and password').toBeGreaterThan(0)
  expect(new Set(signedIn.map((request) => request.userId)).size, 'one pair for this app').toBe(1)
  expect(directHits(), 'no decoy, on the same ports on loopback, was ever reached').toBe(0)

  const webrtc = await call('candidates', stunDecoy.port)
  expect(webrtc, 'WebRTC gathers no candidate').toMatchObject({ ok: true, detail: '0' })
  expect(stunDecoy.hits(), 'and talks no UDP').toBe(0)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-keeps-its-loopback-listens] a routed app still listens on loopback and connects to its own listener, which never leaves the computer', async () => {
  const seen = socks.requests.length
  const loopback = await call('loopback', ports.listen)
  expect(loopback, JSON.stringify(loopback)).toMatchObject({ ok: true, detail: '127.0.0.1:hello from the listener' })
  expect(socks.requests.slice(seen).filter((request) => request.port === ports.listen), 'the proxy was not asked about the app\'s own port').toEqual([])
  const direct = await call('tcp', '127.0.0.1', ports.hold)
  expect(direct.ok, 'a loopback address is reached directly').toBe(true)
  expect(socks.requests.slice(seen).filter((request) => request.port === ports.hold)).toEqual([])
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-app-refuses-what-the-route-cannot-carry] a routed app cannot listen where the network can reach it or look a name up, and with the proxy stopped nothing answers and nothing goes anywhere else', async () => {
  const network = await call('listen', 'network')
  expect(network, 'a listen the whole network could reach').toMatchObject({ ok: false, code: 'denied' })
  const lookup = await call('lookup', 'tcp.socks.test')
  expect(lookup, 'a name looked up here').toMatchObject({ ok: false, code: 'denied' })
  const unknown = await call('tcp', 'unknown.socks.test', ports.tcp)
  expect(unknown, 'a name the proxy does not know').toMatchObject({ ok: false, code: 'unreachable' })

  // Changing the proxy closes what the app holds and sends the next connection to the new one.
  expect((await call('hold', '127.0.0.1', ports.hold)).ok).toBe(true)
  const closedBefore = holdDecoy.closed()
  const settings = await openSettings('privacy')
  const proxy = settings.locator('#row-route-proxy input')
  await proxy.fill(`127.0.0.1:${String(secondSocks.port)}`)
  await proxy.press('Tab')
  expect(await waitFor(() => holdDecoy.closed() === closedBefore + 1), 'the connection held open under the old proxy is closed').toBe(true)
  const viaSecond = await call('tcp', 'tcp.socks.test', ports.tcp)
  expect(viaSecond).toMatchObject({ ok: true, detail: 'ping' })
  expect(dialed(secondSocks, 'tcp.socks.test', ports.tcp), 'the new proxy was asked').toBe(true)

  // The proxy stops answering: every way out fails, and nothing is sent direct.
  await secondSocks.close()
  const attempts = [
    await call('tcp', 'tcp.socks.test', ports.tcp),
    await call('secure', 'tls.socks.test', ports.tls),
    await call('datagram', 'udp.socks.test', ports.udp),
    await call('webSocket', `ws://ws.socks.test:${String(ports.ws)}/`),
    await call('image', `https://reach.socks.test:${String(ports.reach)}/y.png`)
  ]
  expect(attempts.map((attempt) => attempt.ok), JSON.stringify(attempts)).toEqual([false, false, false, false, false])
  // Chromium finishes loading its own error page for a refused page, so what is shown is what tells.
  const shown = await call('embed', `http://embed.socks.test:${String(ports.embed)}/other`)
  expect(shown.detail, 'the shown page is not the one the server holds').not.toBe('shown through the front')
  expect(directHits(), 'with the proxy stopped, no decoy was reached either').toBe(0)
}, 3 * QA_TEST_TIMEOUT_MS)
