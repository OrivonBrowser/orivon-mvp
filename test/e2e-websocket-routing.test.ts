// ADR-0017 for WebSocket, in a real app tab: a socket to a host the app
// holds a tcp.connect grant for is routed over orivon.net and completes a
// real RFC 6455 exchange with a hand-rolled server (no ws dependency); an
// ungranted host takes the native WebSocket and meets the page's CSP.
//
// The page is served by this file's own server with the CSP an origin granted
// without installing is given (src/loader/serve-csp.ts, the builder
// src/main/install/granted-origin-csp.ts appends), so it also MEASURES what
// that policy's connect-src 'self' does to a dev server's own hot-reload
// socket on the page's host and port.
//
// Plain ws:, not wss:: e2e-connect-secure-capability.test.ts's header says
// why a TLS round trip cannot be proven hermetically here. The wss: path
// differs only in the dial (connectSecure), which the unit suites cover.
//
// PORTS: 8886 (the page, and its own hot-reload socket), 8887 (the granted
// WebSocket server), 8889 (ungranted; nothing listens). Literals inside the
// evaluate callbacks, which cannot close over outer values.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-websocket-routing.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { cspHeaderValue } from '../src/loader/serve-csp.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const HOST = '127.0.0.1'
const PAGE_PORT = 8886
const WS_PORT = 8887
const PAGE_ORIGIN = `http://${HOST}:${PAGE_PORT}`
const PAGE_URL = `${PAGE_ORIGIN}/`
const TITLE = 'Orivon WebSocket fixture'
const GRANT_PATTERN = `${HOST}:${WS_PORT}`
const TEST_TIMEOUT_MS = 120_000
const BIG_MESSAGE_BYTES = 200_000

const PAGE_HTML = `<!doctype html><html><head><title>${TITLE}</title><script>
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => { window.__violations.push(e.effectiveDirective + ' <- ' + e.blockedURI) })
</script></head><body>websocket fixture</body></html>`

const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 }

/** One unmasked server frame. */
function frame (opcode: number, payload: Buffer, fin = true): Buffer {
  const head = payload.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length])
    : payload.length < 65536
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, payload.length >> 8, payload.length & 0xff])
      : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b })()])
  return Buffer.concat([head, payload])
}

interface Session {
  readonly request: IncomingMessage
  readonly allMasked: () => boolean
  readonly pongs: string[]
  readonly closeFrames: Buffer[]
}

/** Completes the server half of the opening handshake, then hands every client frame, unmasked, to `onFrame`. */
function accept (request: IncomingMessage, socket: Duplex, protocol: string | undefined, onFrame: (opcode: number, payload: Buffer, session: Session) => void): Session {
  const key = request.headers['sec-websocket-key'] ?? ''
  const digest = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${digest}`,
    ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]), '', ''].join('\r\n'))
  let masked = true
  const session: Session = { request, allMasked: () => masked, pongs: [], closeFrames: [] }
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      let length = buffer[1]! & 0x7f
      let at = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4 }
      if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); at = 10 }
      const isMasked = (buffer[1]! & 0x80) !== 0
      masked &&= isMasked
      const start = at + (isMasked ? 4 : 0)
      if (buffer.length < start + length) return
      const payload = Buffer.from(buffer.subarray(start, start + length))
      if (isMasked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ buffer[at + (i % 4)]!
      const opcode = buffer[0]! & 0x0f
      buffer = buffer.subarray(start + length)
      if (opcode === OP.pong) session.pongs.push(payload.toString())
      if (opcode === OP.close) {
        session.closeFrames.push(payload)
        socket.end(frame(OP.close, payload))
        return
      }
      onFrame(opcode, payload, session)
    }
  })
  socket.on('error', () => {})
  return session
}

let pageServer: Server
let wsServer: Server
const sessions: Session[] = []
/** Upgraded sockets leave the http server's bookkeeping, so closeAllConnections() cannot end them. */
const upgraded = new Set<Duplex>()
const hotReloadLog: string[] = []

beforeAll(async () => {
  const csp = cspHeaderValue([GRANT_PATTERN], [])
  pageServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp })
    res.end(PAGE_HTML)
  })
  // The dev server's own hot-reload socket: same host and port as the page.
  pageServer.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    upgraded.add(socket)
    hotReloadLog.push(`upgrade extensions=${String(request.headers['sec-websocket-extensions'])}`)
    socket.on('close', () => { hotReloadLog.push('socket closed') })
    accept(request, socket, undefined, (opcode) => { hotReloadLog.push(`frame ${opcode}`) })
    socket.write(frame(OP.text, Buffer.from('hmr-ready')))
  })
  wsServer = createServer((_req, res) => { res.writeHead(426).end() })
  wsServer.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    upgraded.add(socket)
    const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim())
    const session = accept(request, socket, offered.includes('chat') ? 'chat' : undefined, (opcode, payload) => {
      if (opcode === OP.text && payload.toString() === 'big') {
        const big = Buffer.from(Uint8Array.from({ length: BIG_MESSAGE_BYTES }, (_, i) => i & 0xff))
        const third = Math.floor(BIG_MESSAGE_BYTES / 3)
        socket.write(Buffer.concat([
          frame(OP.binary, big.subarray(0, third), false),
          frame(OP.ping, Buffer.from('mid')),
          frame(OP.continuation, big.subarray(third, 2 * third), false),
          frame(OP.continuation, big.subarray(2 * third))
        ]))
      } else if (opcode === OP.text) {
        socket.write(frame(OP.text, Buffer.from(`echo:${payload.toString()}`)))
      } else if (opcode === OP.binary) {
        socket.write(frame(OP.binary, payload))
      }
    })
    sessions.push(session)
    const { origin, 'user-agent': agent, 'sec-websocket-extensions': extensions, cookie } = request.headers
    socket.write(frame(OP.text, Buffer.from(JSON.stringify({ origin, agent, extensions: extensions ?? null, cookie: cookie ?? null }))))
    socket.write(frame(OP.ping, Buffer.from('hb')))
  })
  await Promise.all([
    new Promise<void>((resolve) => { pageServer.listen(PAGE_PORT, HOST, resolve) }),
    new Promise<void>((resolve) => { wsServer.listen(WS_PORT, HOST, resolve) })
  ])
}, 15_000)

afterAll(async () => {
  for (const socket of upgraded) socket.destroy()
  await Promise.all([
    new Promise<void>((resolve) => { pageServer.close(() => resolve()); pageServer.closeAllConnections() }),
    new Promise<void>((resolve) => { wsServer.close(() => resolve()); wsServer.closeAllConnections() })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('an app tab\'s WebSocket reaches a granted host over orivon.net, and an ungranted one goes native under the page\'s CSP', async () => {
  await runPhase('websocket routing', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      const manifest: Manifest = {
        orivonApiVersion: 0,
        id: 'app.orivon.fixture.websocket-routing',
        name: 'Orivon Fixture (WebSocket routing)',
        version: '0.1.0',
        entry: 'index.html',
        capabilities: { net: { tcp: { connect: [GRANT_PATTERN] } } }
      }
      // Granted BEFORE navigation: whether the tab is an app tab is decided when its view is built.
      const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return false
        await hook(request)
        return true
      }, { origin: PAGE_ORIGIN, manifest, capability: 'tcp.connect', patterns: [GRANT_PATTERN] } satisfies DevGrantRequest)
      check('the developer-only grant hook is installed in this build (built by scripts/build-e2e.mjs)', granted)
      if (!granted) throw new Error('dev-grant hook missing -- was this built via scripts/build-e2e.mjs?')

      const view = await navigateToFixture(app, PAGE_URL, TITLE)
      const consoleLines: string[] = []
      view.on('console', (message: { text: () => string }) => { consoleLines.push(message.text()) })

      // (a) THE GRANTED HOST. The page's CSP names 127.0.0.1:8887 only as a
      // bare host:port, which admits no ws: URL, so a socket that opens at
      // all opened through orivon.net.
      const routed = await evaluateRetrying(view, async () => await new Promise<unknown[]>((resolve) => {
        const log: unknown[] = []
        const ws = new WebSocket('ws://127.0.0.1:8887/echo', ['chat', 'superchat'])
        ws.binaryType = 'arraybuffer'
        let pending = 4
        const got = (entry: unknown): void => {
          log.push(entry)
          if (--pending === 0) ws.close(1000, 'done')
        }
        ws.onopen = () => {
          log.push(['open', ws.protocol, ws.extensions])
          ws.send('hello')
          ws.send(new Uint8Array([1, 2, 3]))
          ws.send('big')
        }
        ws.onmessage = (e: MessageEvent) => {
          if (typeof e.data === 'string') got(e.data.startsWith('{') ? ['headers', JSON.parse(e.data) as unknown] : ['text', e.data])
          else got(['binary', (e.data as ArrayBuffer).byteLength, Array.from(new Uint8Array(e.data as ArrayBuffer).subarray(0, 3))])
        }
        ws.onerror = () => { log.push(['error']) }
        ws.onclose = (e) => { log.push(['close', e.code, e.reason, e.wasClean]); resolve(log) }
        setTimeout(() => { log.push(['timeout', ws.readyState]); resolve(log) }, 15_000)
      }), 20_000)
      const detail = JSON.stringify(routed)
      const find = (tag: string): unknown[] | undefined => routed.find((e: unknown) => Array.isArray(e) && e[0] === tag) as unknown[] | undefined
      const headers = find('headers')?.[1] as { origin?: string, agent?: string, extensions?: string | null, cookie?: string | null } | undefined
      const binaries = routed.filter((e: unknown) => Array.isArray(e) && e[0] === 'binary') as unknown[][]
      check('the granted socket opens and negotiates the subprotocol the server chose, with no extension',
        JSON.stringify(find('open')) === JSON.stringify(['open', 'chat', '']), detail)
      check('the upgrade carried the page\'s own origin and the browser\'s User-Agent, no extension offer and no cookie',
        headers?.origin === PAGE_ORIGIN && typeof headers.agent === 'string' && headers.extensions === null && headers.cookie === null, detail)
      check('a text message round-trips', routed.some((e: unknown) => JSON.stringify(e) === JSON.stringify(['text', 'echo:hello'])), detail)
      check('a binary message round-trips as an ArrayBuffer', binaries.some((e) => e[1] === 3 && JSON.stringify(e[2]) === '[1,2,3]'), detail)
      check(`a ${BIG_MESSAGE_BYTES}-byte message fragmented across three frames, with a ping between them, is reassembled`,
        binaries.some((e) => e[1] === BIG_MESSAGE_BYTES && JSON.stringify(e[2]) === '[0,1,2]'), detail)
      check('the close handshake completes cleanly with the code the server echoed',
        JSON.stringify(routed.at(-1)) === JSON.stringify(['close', 1000, 'done', true]) && find('error') === undefined, detail)
      const session = sessions[0]
      check('the server saw exactly one routed session, every client frame masked', sessions.length === 1 && session?.allMasked() === true, `sessions=${sessions.length}`)
      check('both server pings were answered with pongs carrying their payloads',
        session !== undefined && session.pongs.includes('hb') && session.pongs.includes('mid'), JSON.stringify(session?.pongs))
      check('the client\'s close frame carried 1000 and its reason',
        session?.closeFrames[0]?.toString('hex') === Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('done')]).toString('hex'),
        session?.closeFrames[0]?.toString('hex'))

      // (b) AN UNGRANTED HOST takes the native WebSocket, which the page's
      // CSP then refuses, as it would on any page. It is the page's own host
      // on another port, so this also measures a dev server that puts its
      // hot-reload socket on a separate port: refused, since 'self' names the
      // page's port only. MEASURED: a CSP-blocked native socket fires error
      // and goes CLOSED with no close event.
      const native = await evaluateRetrying(view, async () => await new Promise<unknown>((resolve) => {
        const log: string[] = []
        const ws = new WebSocket('ws://127.0.0.1:8889/x')
        const report = (): void => { resolve({ log, readyState: ws.readyState, violations: (window as unknown as { __violations: string[] }).__violations }) }
        ws.onerror = () => { log.push('error'); setTimeout(report, 1_500) }
        ws.onclose = (e) => { log.push(`close ${e.code} ${String(e.wasClean)}`) }
        setTimeout(() => { log.push('timeout'); report() }, 8_000)
      }), 12_000) as { log: string[], readyState: number, violations: string[] }
      console.log(`[e2e-websocket-routing] ungranted socket: ${JSON.stringify(native)}`)
      check('an ungranted host takes the native WebSocket, which fails it: an error event and CLOSED',
        native.log[0] === 'error' && native.readyState === 3, JSON.stringify(native))
      check('and it was the page\'s connect-src that refused it', native.violations.some((v) => v.startsWith('connect-src <- ws://127.0.0.1:8889')), JSON.stringify(native))

      // (c) MEASURED: a dev server's hot-reload socket, on the page's own
      // host and port, under the CSP an origin granted without installing is served.
      const hotReload = await evaluateRetrying(view, async () => await new Promise<unknown>((resolve) => {
        const before = (window as unknown as { __violations: string[] }).__violations.length
        const log: string[] = []
        const ws = new WebSocket('ws://127.0.0.1:8886/hmr')
        const done = (): void => { resolve({ log, violations: (window as unknown as { __violations: string[] }).__violations.slice(before) }) }
        ws.onopen = () => { log.push('open') }
        ws.onmessage = (e: MessageEvent) => { log.push(`message ${String(e.data)}`); ws.close(); setTimeout(done, 300) }
        ws.onerror = () => { log.push('error') }
        ws.onclose = () => { log.push('close'); setTimeout(done, 300) }
        setTimeout(done, 8_000)
      }), 12_000) as { log: string[], violations: string[] }
      console.log(`[e2e-websocket-routing] hot-reload socket under the dev CSP: ${JSON.stringify({ hotReload, hotReloadLog, consoleLines })}`)
      check('MEASURED: connect-src \'self\' admits a ws: socket to the page\'s own host and port (a dev server\'s hot reload)',
        hotReload.log.includes('open') && hotReload.log.includes('message hmr-ready') && hotReload.violations.length === 0,
        JSON.stringify({ hotReload, hotReloadLog }))
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
