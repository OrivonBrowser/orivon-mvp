// A page `WebSocket` to a granted host: over `wss://` it completes the handshake carrying the page's own origin as
// `Origin`, agrees the subprotocol the page offered, exchanges text frames both ways, and keeps working beside routed
// `fetch` calls to the same host; over `ws://` it reaches a loopback port the manifest names and no other. The servers
// record the handshake they were sent. The https server's certificate is one the main process trusts (the launch adds it
// through NODE_EXTRA_CA_CERTS, the way an operator would), as in e2e-app-self-signed-tls.
// Every check carries the id of the behaviour it protects (test/app-behaviours/catalogue.md).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-routed-websocket.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { generateSelfSignedFixture } from '../../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import { appManifest, grantApp, pageCall, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay } from '../support/smoke-helpers.mjs'

interface Handshake { readonly origin: string | undefined, readonly protocols: string | undefined }

interface Host { readonly port: number, readonly handshakes: Handshake[], readonly close: () => Promise<void> }

/** Accepts the `chat` subprotocol when offered and answers every text frame with `echo:` and the text. */
function sockets (record: Handshake[]): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (offered) => (offered.has('chat') ? 'chat' : false) })
  wss.on('connection', (socket, request: IncomingMessage) => {
    record.push({ origin: request.headers.origin, protocols: request.headers['sec-websocket-protocol'] })
    socket.on('message', (data) => { socket.send(`echo:${data.toString()}`) })
  })
  return wss
}

async function secureHost (fixture: { cert: string, key: string }): Promise<Host> {
  const handshakes: Handshake[] = []
  const wss = sockets(handshakes)
  const web: HttpsServer = createHttpsServer({ key: fixture.key, cert: fixture.cert }, (_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('pong') })
  web.on('upgrade', (request, socket, head) => { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request) }) })
  await new Promise<void>((resolve) => { web.listen(0, '127.0.0.1', resolve) })
  return { port: (web.address() as AddressInfo).port, handshakes, close: async () => { wss.close(); web.closeAllConnections(); await new Promise<void>((resolve) => { web.close(() => { resolve() }) }) } }
}

async function plainHost (): Promise<Host> {
  const handshakes: Handshake[] = []
  const wss = sockets(handshakes)
  const web: HttpServer = createHttpServer()
  web.on('upgrade', (request, socket, head) => { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request) }) })
  await new Promise<void>((resolve) => { web.listen(0, '127.0.0.1', resolve) })
  return { port: (web.address() as AddressInfo).port, handshakes, close: async () => { wss.close(); web.closeAllConnections(); await new Promise<void>((resolve) => { web.close(() => { resolve() }) }) } }
}

let dir: string
let secure: Host
let plain: Host
let other: Host
let appServer: AppServer
let app: ElectronApplication
let chrome: Page
let view: Page

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-routed-websocket-'))
  const known = generateSelfSignedFixture()
  const caFile = join(dir, 'trusted.pem')
  writeFileSync(caFile, known.cert)
  secure = await secureHost(known)
  plain = await plainHost()
  other = await plainHost()
  appServer = await startAppServer()
  // The suite's blackhole resolver maps `localhost` to nothing; the certificate names it, so it resolves here (to loopback, as anywhere).
  const launched = await launchShell({ env: { NODE_EXTRA_CA_CERTS: caFile }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] })
  app = launched.app
  chrome = launched.chrome
  const secureGrant = `localhost:${String(secure.port)}`
  const plainGrant = `localhost:${String(plain.port)}`
  await grantApp(app, appServer.origin, appManifest('routed-websocket', { net: { https: { connect: [secureGrant] }, tcp: { connect: [plainGrant] } } }), [
    { capability: 'https.connect', patterns: [secureGrant] },
    { capability: 'tcp.connect', patterns: [plainGrant] }
  ])
  view = await visit(app, chrome, `${appServer.origin}/`)
}, 180_000)

afterAll(async () => {
  if (app !== undefined) await closeElectron(app)
  await appServer?.close()
  await Promise.all([secure, plain, other].map(async (host) => { await host?.close() }))
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:routed-websocket-wss-carries-origin-and-subprotocol] a WebSocket to a granted wss host sends the page\'s origin, agrees the subprotocol offered, echoes text frames, and works beside routed fetch calls to the same host', async () => {
  const outcome = await pageCall(appServer, view, async (wsUrl: string, httpsUrl: string) => {
    const conversation = async (url: string, protocols: string[]): Promise<{ opened: boolean, protocol: string, reply: string }> => await new Promise((resolve) => {
      const socket = new WebSocket(url, protocols)
      const timer = setTimeout(() => { resolve({ opened: false, protocol: '', reply: 'timeout' }) }, 20_000)
      socket.onopen = () => { socket.send('hello') }
      socket.onmessage = (event) => { clearTimeout(timer); const protocol = socket.protocol; socket.close(); resolve({ opened: true, protocol, reply: String(event.data) }) }
      socket.onerror = () => { clearTimeout(timer); resolve({ opened: false, protocol: '', reply: 'error' }) }
    })
    const socket = await conversation(wsUrl, ['other', 'chat'])
    const fetched = await (await fetch(httpsUrl)).text()
    const again = await conversation(wsUrl, ['chat'])
    return { socket, fetched, again }
  }, `wss://localhost:${String(secure.port)}/socket`, `https://localhost:${String(secure.port)}/ping`)
  expect(outcome.socket, 'opened, with the subprotocol the server chose').toEqual({ opened: true, protocol: 'chat', reply: 'echo:hello' })
  expect(outcome.fetched, 'a routed fetch to the same host').toBe('pong')
  expect(outcome.again, 'and a second socket afterwards').toEqual({ opened: true, protocol: 'chat', reply: 'echo:hello' })
  expect(secure.handshakes[0], 'what the server was sent').toEqual({ origin: appServer.origin, protocols: 'other, chat' })
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-websocket-reaches-granted-loopback-port] a WebSocket to ws://localhost:<named port> connects and echoes, and one to another loopback port is not reached', async () => {
  const outcome = await pageCall(appServer, view, async (granted: string, ungranted: string) => {
    const conversation = async (url: string, protocols: string[]): Promise<{ opened: boolean, protocol: string, reply: string }> => await new Promise((resolve) => {
      const socket = new WebSocket(url, protocols)
      const timer = setTimeout(() => { resolve({ opened: false, protocol: '', reply: 'timeout' }) }, 20_000)
      socket.onopen = () => { socket.send('hello') }
      socket.onmessage = (event) => { clearTimeout(timer); const protocol = socket.protocol; socket.close(); resolve({ opened: true, protocol, reply: String(event.data) }) }
      socket.onerror = () => { clearTimeout(timer); resolve({ opened: false, protocol: '', reply: 'error' }) }
    })
    return { granted: await conversation(granted, ['chat']), ungranted: await conversation(ungranted, ['chat']) }
  }, `ws://localhost:${String(plain.port)}/socket`, `ws://localhost:${String(other.port)}/socket`)
  expect(outcome.granted, 'the named port').toEqual({ opened: true, protocol: 'chat', reply: 'echo:hello' })
  expect(outcome.ungranted.opened, 'a port the manifest does not name').toBe(false)
  await delay(ABSENCE_SETTLE_MS)
  expect(other.handshakes, 'nothing reached it').toEqual([])
  expect(plain.handshakes[0]?.origin, 'the named port saw the page\'s origin').toBe(appServer.origin)
}, QA_TEST_TIMEOUT_MS)
