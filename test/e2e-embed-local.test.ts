// web.embed's local pattern end to end (ADR-0047), against the real shell and
// the real broker: an app that lists `http://*.localhost:<port>` shows pages it
// serves itself, each label an origin of its own, and only while the app itself
// holds a TCP listener on that port.
//
// The fixture app serves the pages from its own page: `orivon.net.listen`, then
// a hand-written HTTP/1.1 answer per connection whose title is the Host header,
// so the page proves which name reached the app's listener. Ports 9171 (the
// app's) and 9172 (a listener the TEST holds, standing for another program)
// are used by no other e2e file.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-embed-local.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { Server as TcpServer } from 'node:net'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { asPage, closeElectronApp, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const HOST = '127.0.0.1'
/** The suite's hermetic resolver (smoke-helpers.mjs's HERMETIC_RESOLVER) with every `localhost` name left to Chromium, which answers it with loopback itself. */
const LOCALHOST_RESOLVER = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE *.localhost, EXCLUDE localhost'
const APP_PORT = 9171
const OTHER_PORT = 9172
const APP_SERVER_PORT = 9173
const FIXTURE_ORIGIN = `http://${HOST}:${APP_SERVER_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
const AS_PAGE_URL = `${FIXTURE_URL}as-page.js`
const STEP_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 180_000

/** The app's own listener, the port a listener of another program holds, and the patterns the manifest names. */
const BARE_PATTERN = `http://*.localhost:${APP_PORT}`
const NAMED_PATTERN = `http://*.shared.localhost:${APP_PORT}`
const OTHER_PATTERN = `http://*.localhost:${OTHER_PORT}`

// The app's own page and the script asPage (e2e-helpers.ts) loads into it, served from this file rather than
// test/apps/fixture/ so a run beside another e2e file that serves that fixture cannot collide on its port.
let asPageScript = ''
const setAsPageScript = (js: string): void => { asPageScript = js }
const appServer = createHttpServer((req, res) => {
  if (req.url?.startsWith('/as-page.js') === true) {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(asPageScript)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><html><head><meta charset="utf-8"><title>Orivon embed local fixture</title></head><body><h1>Orivon embed local fixture</h1></body></html>')
})
const PAGE_TITLE = 'Orivon embed local fixture'

/** A listener this process holds itself: another program on the computer, as far as the app is concerned. */
let strangerConnections = 0
const stranger: TcpServer = createTcpServer((socket) => { strangerConnections += 1; socket.destroy() })

beforeAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => { appServer.listen(APP_SERVER_PORT, HOST, resolve) }),
    new Promise<void>((resolve) => { stranger.listen(OTHER_PORT, HOST, resolve) })
  ])
  await Promise.all([waitForTcpReady(HOST, APP_SERVER_PORT, 10_000), waitForTcpReady(HOST, OTHER_PORT, 10_000)])
  strangerConnections = 0
}, 15_000)

afterAll(async () => {
  await Promise.all([appServer, stranger].map(async (server) => await new Promise<void>((resolve) => { server.close(() => resolve()) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

function manifestFor (id: string, origins: readonly string[]): Manifest {
  return {
    orivonApiVersion: 0,
    id,
    name: 'Orivon embed local e2e fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: {
      net: { tcp: { listen: { network: [String(APP_PORT)] } } },
      web: { embed: { origins } }
    }
  }
}

/** The page-side surface this file drives, defined once on the app page so every later step is one short call. */
interface E2eSurface {
  show: (id: string, url: string) => Promise<string>
  run: (id: string, code: string) => Promise<unknown>
}

/** Installed on the app page (through Playwright, so it may not use `orivon`): builds `<webview>`s and drives them. */
function installSurface (): void {
  interface Element_ extends HTMLElement { loadURL: (url: string) => Promise<void>, executeJavaScript: (code: string) => Promise<unknown> }
  const views = new Map<string, Element_>()
  const surface = {
    // The element is attached on `about:blank` (always admitted), then sent to `url`: a document the grant refuses
    // makes `loadURL` reject and leaves the element on the blank page (README.md of src/main/embed).
    async show (id: string, url: string): Promise<string> {
      let el = views.get(id)
      if (el === undefined) {
        const created = document.createElement('webview') as Element_
        created.setAttribute('src', 'about:blank')
        created.style.width = '400px'
        created.style.height = '300px'
        const ready = new Promise<void>((resolve) => { created.addEventListener('did-finish-load', () => { resolve() }, { once: true }) })
        document.body.appendChild(created)
        await ready
        views.set(id, created)
        el = created
      }
      try {
        await el.loadURL(url)
        return 'loaded'
      } catch (error) {
        // ERR_FAILED is what the shell's own cancel reports; a closed port with nothing checking would say ERR_CONNECTION_REFUSED.
        return `refused:${/ERR_[A-Z_]+/.exec(String((error as { message?: string }).message))?.[0] ?? 'other'}`
      }
    },
    async run (id: string, code: string): Promise<unknown> {
      const el = views.get(id)
      if (el === undefined) throw new Error(`no view ${id}`)
      return await el.executeJavaScript(code)
    }
  }
  ;(window as unknown as { __e2e: E2eSurface }).__e2e = surface
}

/** `orivon.net.listen` on `port`, answering every connection with a page whose title is the Host header it arrived under. */
async function serveOwnPages (port: number): Promise<number> {
  const orivon = (window as unknown as { orivon: { net: { listen: (o: { port: number, scope: string }) => Promise<{ localPort: number, connections: ReadableStream<{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }> }> } } }).orivon
  const server = await orivon.net.listen({ port, scope: 'network' })
  ;(window as unknown as { __ownServer: unknown }).__ownServer = server
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const answer = async (socket: { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }): Promise<void> => {
    try {
      const reader = socket.readable.getReader()
      let request = ''
      while (!request.includes('\r\n\r\n')) {
        const { value, done } = await reader.read()
        if (done) break
        request += decoder.decode(value, { stream: true })
      }
      const host = /^host:\s*([^\r\n]*)/im.exec(request)?.[1] ?? ''
      const body = `<!doctype html><html><head><title>${host}</title></head><body>${host}</body></html>`
      const head = `HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${String(encoder.encode(body).length)}\r\nconnection: close\r\n\r\n`
      const writer = socket.writable.getWriter()
      await writer.write(encoder.encode(head + body))
      await writer.close()
    } catch { /* one connection failing is that connection's business */ } finally {
      try { await socket.close() } catch { /* already closed */ }
    }
  }
  const accept = async (): Promise<void> => {
    const reader = server.connections.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      void answer(value)
    }
  }
  void accept().catch(() => {})
  return server.localPort
}

async function closeOwnServer (): Promise<string> {
  const server = (window as unknown as { __ownServer: { close: () => Promise<void> } }).__ownServer
  await server.close()
  return 'closed'
}

async function grant (app: Awaited<ReturnType<typeof launchElectron>>, manifest: Manifest, capability: 'web.embed' | 'tcp.listen.network', patterns: readonly string[]): Promise<boolean> {
  const outcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook(request)
    return true
  }, { origin: FIXTURE_ORIGIN, manifest, capability, patterns } satisfies DevGrantRequest)
  return outcome
}

function drive (view: Awaited<ReturnType<typeof navigateToFixture>>): { show: (id: string, url: string) => Promise<string>, run: (id: string, code: string) => Promise<unknown> } {
  return {
    show: async (id, url) => await view.evaluate(([i, u]: [string, string]) => (window as unknown as { __e2e: E2eSurface }).__e2e.show(i, u), [id, url] as [string, string]),
    run: async (id, code) => await view.evaluate(([i, c]: [string, string]) => (window as unknown as { __e2e: E2eSurface }).__e2e.run(i, c), [id, code] as [string, string])
  }
}

type Check = (name: string, pass: boolean, detail?: string) => void

it(
  'a local pattern shows pages the app serves itself, one origin per label, only while the app holds the listener: ' +
  'another program\'s port and a closed listener do not load, and a cookie set for "localhost" does not cross labels',
  async () => {
    await runPhase('web.embed local pattern e2e', async (check: Check) => {
      const app = await launchElectron({ appPath: '.', args: [LOCALHOST_RESOLVER] })
      try {
        const manifest = manifestFor('app.orivon.embed-local-e2e', [BARE_PATTERN, NAMED_PATTERN, OTHER_PATTERN])
        const installed = await grant(app, manifest, 'tcp.listen.network', [String(APP_PORT)])
        check('the developer-only grant hook is installed in this build', installed)
        if (!installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        await grant(app, manifest, 'web.embed', [BARE_PATTERN, NAMED_PATTERN, OTHER_PATTERN])

        const view = await navigateToFixture(app, FIXTURE_URL, PAGE_TITLE)
        await view.evaluate(installSurface)
        const { show, run } = drive(view)

        // ---- (1) the app holds no listener yet, so a page under its own pattern does not load.
        const before = await show('a', `http://a.localhost:${APP_PORT}/`)
        check('before the app listens, a page under its local pattern is refused', before === 'refused:ERR_FAILED', before)

        // ---- (2) the app listens; two labels load, each an origin of its own.
        const port = await asPage(view, setAsPageScript, AS_PAGE_URL, serveOwnPages, APP_PORT)
        check('the app listens on its port through orivon.net.listen', port === APP_PORT, String(port))

        const a = await show('a', `http://a.localhost:${APP_PORT}/`)
        const b = await show('b', `http://b.localhost:${APP_PORT}/`)
        check('http://a.localhost:<port>/ loads once the app holds the listener', a === 'loaded', a)
        check('http://b.localhost:<port>/ loads in a second <webview>', b === 'loaded', b)
        const probe = 'JSON.stringify({ title: document.title, origin: location.origin, secure: isSecureContext, subtle: typeof crypto.subtle })'
        const infoA = JSON.parse(String(await run('a', probe))) as { title: string, origin: string, secure: boolean, subtle: string }
        const infoB = JSON.parse(String(await run('b', probe))) as { title: string, origin: string, secure: boolean, subtle: string }
        check('the app\'s listener saw the Host header of each label', infoA.title === `a.localhost:${APP_PORT}` && infoB.title === `b.localhost:${APP_PORT}`, JSON.stringify({ infoA, infoB }))
        check('each label has its own origin', infoA.origin === `http://a.localhost:${APP_PORT}` && infoB.origin === `http://b.localhost:${APP_PORT}`, JSON.stringify({ infoA, infoB }))
        check('each page is a secure context with crypto.subtle', infoA.secure && infoB.secure && infoA.subtle === 'object' && infoB.subtle === 'object', JSON.stringify({ infoA, infoB }))
        await run('a', 'localStorage.setItem("k", "from-a"); 0')
        const storedAtB = await run('b', 'String(localStorage.getItem("k"))')
        const storedAtA = await run('a', 'String(localStorage.getItem("k"))')
        check('localStorage is not shared between labels', storedAtA === 'from-a' && storedAtB === 'null', JSON.stringify({ storedAtA, storedAtB }))

        // ---- (3) cookies: measured, then asserted as the contract states.
        await run('a', 'document.cookie = "bare=1; Domain=localhost; path=/"; 0')
        const bareAtA = String(await run('a', 'document.cookie'))
        const bareAtB = String(await run('b', 'document.cookie'))
        console.error(`[measured] Domain=localhost set at a.localhost -> read at a: ${JSON.stringify(bareAtA)}, at b: ${JSON.stringify(bareAtB)}`)
        check('a cookie a.localhost sets with Domain=localhost is not readable at b.localhost', !bareAtB.includes('bare=1'), JSON.stringify({ bareAtA, bareAtB }))

        const sa = await show('sa', `http://a.shared.localhost:${APP_PORT}/`)
        const sb = await show('sb', `http://b.shared.localhost:${APP_PORT}/`)
        check('two labels under the named form load', sa === 'loaded' && sb === 'loaded', JSON.stringify({ sa, sb }))
        await run('sa', 'document.cookie = "named=1; Domain=shared.localhost; path=/"; 0')
        const namedAtSa = String(await run('sa', 'document.cookie'))
        const namedAtSb = String(await run('sb', 'document.cookie'))
        console.error(`[measured] Domain=shared.localhost set at a.shared.localhost -> read at a: ${JSON.stringify(namedAtSa)}, at b.shared.localhost: ${JSON.stringify(namedAtSb)}`)
        check('a cookie set with Domain=shared.localhost is readable across the labels under it (ADR-0047)', namedAtSb.includes('named=1'), JSON.stringify({ namedAtSa, namedAtSb }))
        await run('sa', 'document.cookie = "hostonly=1; path=/"; 0')
        const hostOnlyAtSb = String(await run('sb', 'document.cookie'))
        check('a host-only cookie stays with its label', !hostOnlyAtSb.includes('hostonly=1'), hostOnlyAtSb)

        // ---- (4) a 63-character label loads, a 64-character one is not a label the pattern names.
        const long63 = await show('l63', `http://${'a'.repeat(63)}.localhost:${APP_PORT}/`)
        const long64 = await show('l64', `http://${'a'.repeat(64)}.localhost:${APP_PORT}/`)
        check('a label of 63 characters loads', long63 === 'loaded', long63)
        check('a label of 64 characters does not', long64 === 'refused:ERR_FAILED', long64)

        // ---- (5) a two-label host, the bare name, an address, and another port are not what `*` stands for.
        const twoLabels = await show('two', `http://x.y.localhost:${APP_PORT}/`)
        const bareName = await show('bare', `http://localhost:${APP_PORT}/`)
        const literal = await show('lit', `http://127.0.0.1:${APP_PORT}/`)
        const otherPort = await show('port', `http://a.localhost:${APP_PORT + 5}/`)
        check('two labels where * stands are refused', twoLabels === 'refused:ERR_FAILED', twoLabels)
        check('the bare localhost name is refused', bareName === 'refused:ERR_FAILED', bareName)
        check('127.0.0.1 named by address is refused', literal === 'refused:ERR_FAILED', literal)
        check('a port the pattern does not name is refused', otherPort === 'refused:ERR_FAILED', otherPort)

        // ---- (6) another program's listener on a port the manifest names does not load, and is never connected to.
        const strangerLoad = await show('stranger', `http://a.localhost:${OTHER_PORT}/`)
        check('a listener another program holds on a named port does not load', strangerLoad === 'refused:ERR_FAILED', strangerLoad)
        check('the request never reached that listener', strangerConnections === 0, String(strangerConnections))

        // ---- (7) the app closes its listener: the same address no longer loads.
        const closed = await asPage(view, setAsPageScript, AS_PAGE_URL, closeOwnServer)
        check('the app closes its listener', closed === 'closed', closed)
        const after = await show('a', `http://a.localhost:${APP_PORT}/?again`)
        const afterFresh = await show('fresh', `http://c.localhost:${APP_PORT}/`)
        check('the address that loaded now refuses, in the element that showed it', after === 'refused:ERR_FAILED', after)
        check('a new label refuses too', afterFresh === 'refused:ERR_FAILED', afterFresh)
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)

it(
  '"*" listed beside a local pattern still leaves loopback closed by address and by the bare name, and the pattern loads',
  async () => {
    await runPhase('web.embed "*" beside a local pattern e2e', async (check: Check) => {
      const app = await launchElectron({ appPath: '.', args: [LOCALHOST_RESOLVER] })
      try {
        const manifest = manifestFor('app.orivon.embed-local-e2e-wildcard', ['*', BARE_PATTERN])
        const installed = await grant(app, manifest, 'tcp.listen.network', [String(APP_PORT)])
        check('the developer-only grant hook is installed in this build', installed)
        if (!installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        await grant(app, manifest, 'web.embed', ['*', BARE_PATTERN])

        const view = await navigateToFixture(app, FIXTURE_URL, PAGE_TITLE)
        await view.evaluate(installSurface)
        const { show } = drive(view)
        await asPage(view, setAsPageScript, AS_PAGE_URL, serveOwnPages, APP_PORT)

        const local = await show('a', `http://a.localhost:${APP_PORT}/`)
        const literal = await show('lit', `http://127.0.0.1:${APP_PORT}/`)
        const bareName = await show('bare', `http://localhost:${APP_PORT}/`)
        const otherLocal = await show('other', `http://a.localhost:${OTHER_PORT}/`)
        check('the local pattern loads beside "*"', local === 'loaded', local)
        check('"*" does not reach 127.0.0.1 named by address', literal === 'refused:ERR_FAILED', literal)
        check('"*" does not reach the bare localhost name', bareName === 'refused:ERR_FAILED', bareName)
        check('"*" does not reach a localhost label on a port the pattern does not name', otherLocal === 'refused:ERR_FAILED', otherLocal)
        check('the request never reached a listener the app does not hold', strangerConnections === 0, String(strangerConnections))
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
