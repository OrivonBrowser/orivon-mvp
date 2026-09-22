// End-to-end proof that a pinned bundle runs under the real served CSP
// (src/loader/serve-csp.ts) the things real bundles do: compile WebAssembly,
// show a data: image, start a blob: worker, load a data: iframe, and eval.
// Unit tests prove the header string; only Chromium can prove what the
// header admits.
//
// A second phase measures two Electron/Chromium behaviours the reach path
// depends on, on a throwaway probe partition with its own protocol.handle
// (so the probe controls every response): what happens to a 3xx a
// protocol.handle handler returns, and which connect-src sources admit a
// wss: WebSocket, which no protocol.handle ever sees.
//
// PORTS: 8893 (a plain TCP server a wss: attempt would reach) and 8894 (a
// loopback server a `*` https grant must never reach), distinct from every
// other e2e file. Literal inside evaluate callbacks, which cannot close over
// outer values.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-served-csp.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/node-storage.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://served-csp-e2e.orivon.test'
const WSS_PROBE_PORT = 8893
const LOOPBACK_PORT = 8894

/** `(i32, i32) -> i32` exporting `add`: the smallest real module, so a compile is a compile and not a validation error. */
const ADD_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b
])

const INDEX_HTML = '<!doctype html><html><head><title>served-csp fixture</title></head><body><h1>csp fixture</h1></body></html>'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.served-csp-e2e',
  name: 'Served CSP e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['add.wasm'],
  capabilities: { net: { https: { connect: ['*:*'] } } }
}

async function pinFixture (userDataDir: string): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(JSON.stringify(MANIFEST)) },
    { path: '/index.html', content: new TextEncoder().encode(INDEX_HTML) },
    { path: '/add.wasm', content: ADD_WASM }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
}

/** Counts raw TCP accepts: the signal that something really dialled, whatever came after. */
function countingServer (): { server: Server, count: () => number, reset: () => void } {
  let accepted = 0
  const server = createServer((socket) => { accepted += 1; socket.destroy() })
  return { server, count: () => accepted, reset: () => { accepted = 0 } }
}

const wssProbe = countingServer()
const loopback = countingServer()

afterAll(async () => {
  await Promise.all([wssProbe.server, loopback.server].map(async (server) => await new Promise<void>((resolve) => { server.close(() => resolve()) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 180_000

it('a pinned bundle compiles wasm, shows data: images, starts blob: workers, loads data: frames and evals under the real served CSP; ' +
  'a `*` https grant admits any https: subresource in the header while the handler still refuses loopback', async () => {
  await Promise.all([
    new Promise<void>((resolve) => { wssProbe.server.listen(WSS_PROBE_PORT, '127.0.0.1', resolve) }),
    new Promise<void>((resolve) => { loopback.server.listen(LOOPBACK_PORT, '127.0.0.1', resolve) })
  ])
  await Promise.all([waitForTcpReady('127.0.0.1', WSS_PROBE_PORT, 10_000), waitForTcpReady('127.0.0.1', LOOPBACK_PORT, 10_000)])
  wssProbe.reset()
  loopback.reset()

  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('served CSP admits what real bundles do', async (check) => {
      const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await pinFixture(userDataDir)

      const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return false
        await hook(request)
        return true
      }, { origin: ORIGIN, manifest: MANIFEST, capability: 'https.connect', patterns: ['*:*'] } satisfies DevGrantRequest)
      check('the developer-only grant hook is installed (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)', granted)
      if (!granted) throw new Error('dev-grant hook missing -- was this built via scripts/build-e2e.mjs?')

      const registered = await app.evaluate(async (_electron, origin: string) => {
        const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
        if (typeof hook !== 'function') return false
        await hook(origin)
        return true
      }, ORIGIN)
      check('the dev-only serve-registration hook is installed', registered)
      if (!registered) throw new Error('dev-serve hook missing')

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'served-csp fixture')

      const csp = await evaluateRetrying(view, async () => (await fetch('/')).headers.get('content-security-policy'))
      check(
        'the served header admits eval and wasm, data:/blob: locally, and https: for the `*` https.connect grant',
        typeof csp === 'string' &&
          csp.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'") &&
          csp.includes("img-src 'self' data: blob: https:") &&
          csp.includes("connect-src 'self' data: blob: https:") &&
          csp.includes("worker-src 'self' blob:") &&
          csp.includes("frame-src 'self' data: blob:") &&
          !/\bwss?:/.test(csp),
        String(csp)
      )

      const outcome = await evaluateRetrying(view, async () => {
        const violations: string[] = []
        document.addEventListener('securitypolicyviolation', (event) => { violations.push(`${event.violatedDirective} <- ${event.blockedURI}`) })
        const settle = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }
        const attempt = async (run: () => Promise<unknown>): Promise<string> => {
          try { return String(await run()) } catch (error) { return `threw ${String(error)}` }
        }
        const addBytes = new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
          0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
          0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b
        ])
        type AddExports = { add: (a: number, b: number) => number }

        const wasmBytes = await attempt(async () => {
          const { instance } = await WebAssembly.instantiate(addBytes)
          return (instance.exports as unknown as AddExports).add(2, 3)
        })
        const wasmStreaming = await attempt(async () => {
          const { instance } = await WebAssembly.instantiateStreaming(fetch('/add.wasm'))
          return (instance.exports as unknown as AddExports).add(20, 22)
        })
        const evalTop = await attempt(async () => eval('6 * 7'))

        const dataImage = await new Promise<string>((resolve) => {
          const img = new Image()
          img.onload = () => { resolve('loaded') }
          img.onerror = () => { resolve('error') }
          img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
        })

        const blobWorker = await new Promise<string>((resolve) => {
          try {
            const url = URL.createObjectURL(new Blob(['postMessage(21 * 2)'], { type: 'text/javascript' }))
            const worker = new Worker(url)
            const timer = setTimeout(() => { resolve('timeout') }, 5_000)
            worker.onmessage = (event) => { clearTimeout(timer); resolve(String(event.data)); worker.terminate() }
            worker.onerror = () => { clearTimeout(timer); resolve('error') }
          } catch (error) { resolve(`threw ${String(error)}`) }
        })

        const frameMessage = async (src: string): Promise<string> => await new Promise((resolve) => {
          const frame = document.createElement('iframe')
          const timer = setTimeout(() => { frame.remove(); resolve('timeout') }, 5_000)
          const onMessage = (event: MessageEvent): void => {
            if (event.source !== frame.contentWindow) return
            clearTimeout(timer)
            window.removeEventListener('message', onMessage)
            frame.remove()
            resolve(String(event.data))
          }
          window.addEventListener('message', onMessage)
          frame.src = src
          document.body.appendChild(frame)
        })
        const frameScript = "<script>let r; try { r = 'eval=' + eval('1 + 1') } catch (e) { r = 'eval-blocked' }" +
          " WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => parent.postMessage(r + ' wasm=ok', '*'), (e) => parent.postMessage(r + ' wasm=' + e.name, '*'))</script>"
        const dataFrame = await frameMessage(`data:text/html,${encodeURIComponent(frameScript)}`)
        // A frame that narrows script-src with its own meta policy: the
        // control proving wasm compilation really is gated by CSP here.
        const narrowedFrame = await frameMessage(`data:text/html,${encodeURIComponent(`<meta http-equiv="content-security-policy" content="script-src 'unsafe-inline'">${frameScript}`)}`)

        // Negative controls: the policy is enforced, not merely present.
        const thirdPartyFrame = await frameMessage('https://elsewhere.orivon.test/')
        const thirdPartyScript = await new Promise<string>((resolve) => {
          const script = document.createElement('script')
          script.onload = () => { resolve('loaded') }
          script.onerror = () => { resolve('error') }
          script.src = 'https://cdn.orivon.test/lib.js'
          document.head.appendChild(script)
        })

        // A `*` https.connect grant: https: admits the request in the
        // header; the handler must still refuse a loopback target.
        const loopbackImages = await Promise.all(['https://localhost:8894/x.png', 'https://127.0.0.1:8894/y.png'].map(async (src) => await new Promise<string>((resolve) => {
          const img = new Image()
          img.onload = () => { resolve('loaded') }
          img.onerror = () => { resolve('error') }
          img.src = src
        })))

        await settle(300)
        return { wasmBytes, wasmStreaming, evalTop, dataImage, blobWorker, dataFrame, narrowedFrame, thirdPartyFrame, thirdPartyScript, loopbackImages, violations }
      }, 60_000)

      await new Promise((resolve) => setTimeout(resolve, 300))
      const detail = JSON.stringify(outcome)
      const violated = (fragment: string): boolean => outcome.violations.some((entry: string) => entry.includes(fragment))

      check('WebAssembly.instantiate compiles inline bytes', outcome.wasmBytes === '5', detail)
      check('WebAssembly.instantiateStreaming compiles the pinned .wasm (served as application/wasm)', outcome.wasmStreaming === '42', detail)
      check('eval runs in the app document', outcome.evalTop === '42', detail)
      check('a data: image loads', outcome.dataImage === 'loaded', detail)
      check('a blob: worker starts and runs', outcome.blobWorker === '42', detail)
      check('a data: iframe loads and runs its script, with eval and wasm (it inherits the app\'s policy)', outcome.dataFrame === 'eval=2 wasm=ok', detail)
      check(
        'CONTROL: a data: iframe whose own meta policy withholds wasm-unsafe-eval cannot compile wasm or eval -- the gate is real',
        outcome.narrowedFrame.startsWith('eval-blocked wasm=') && outcome.narrowedFrame !== 'eval-blocked wasm=ok',
        detail
      )
      check('CONTROL: a third-party https frame is refused by frame-src', violated('frame-src') && outcome.thirdPartyFrame === 'timeout', detail)
      check('CONTROL: a third-party script is refused by script-src -- the https grant widens only the reach directives',
        violated('script-src-elem <- https://cdn.orivon.test') && outcome.thirdPartyScript === 'error', detail)
      check('none of the admitted cases raised a violation',
        !outcome.violations.some((entry: string) => !entry.includes('elsewhere.orivon.test') && !entry.includes('cdn.orivon.test')), detail)
      check('the `*` grant\'s https: source admits a loopback https image in the header (no img-src violation for it)', !violated('localhost:8894') && !violated('127.0.0.1:8894'), detail)
      check('THE LIVE GATE: the handler refused both loopback targets -- the loopback server saw no connection', loopback.count() === 0, `accepted=${String(loopback.count())} ${detail}`)
    })

    await runPhase('protocol.handle redirects and wss: source matching (measured)', async (check) => {
      const measured = await app.evaluate(async ({ session, BrowserWindow }) => {
        const PAGE = 'https://probe.orivon.test'
        const cors = { 'access-control-allow-origin': PAGE }
        interface Seen { method: string, url: string, authorization: string | null, origin: string | null }
        const seen: Seen[] = []
        const redirectBody = { pulled: false, cancelled: false }
        const probeSession = session.fromPartition('orivon-e2e-protocol-probe')
        probeSession.protocol.handle('https', async (request) => {
          const url = new URL(request.url)
          if (url.pathname !== '/favicon.ico') {
            seen.push({ method: request.method, url: request.url, authorization: request.headers.get('authorization'), origin: request.headers.get('origin') })
          }
          if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-headers': 'authorization', 'access-control-allow-methods': 'GET' } })
          }
          if (url.origin === PAGE) {
            return new Response('<!doctype html><title>probe</title>', {
              headers: { 'content-type': 'text/html', 'content-security-policy': url.searchParams.get('csp') ?? "default-src 'self'" }
            })
          }
          if (url.pathname === '/hop') return new Response('moved', { status: 302, headers: { ...cors, location: 'https://hop-b.orivon.test/final' } })
          if (url.pathname === '/loop') {
            // Ends at 60 so the chain terminates: a loader with the Fetch
            // standard's 20-hop cap would have failed long before.
            const n = Number(url.searchParams.get('n'))
            if (n >= 60) return new Response('end', { headers: cors })
            return new Response(null, { status: 302, headers: { ...cors, location: `/loop?n=${String(n + 1)}` } })
          }
          if (url.pathname === '/hop-stream') {
            // Records whether Electron ever reads or cancels a redirect's body.
            const body = new ReadableStream<Uint8Array>({
              pull () { redirectBody.pulled = true },
              cancel () { redirectBody.cancelled = true }
            })
            return new Response(body, { status: 302, headers: { ...cors, location: 'https://hop-b.orivon.test/final' } })
          }
          if (url.pathname === '/no-acao') return new Response('readable?', { headers: { 'content-type': 'text/plain' } })
          // `*`, not the page origin: after a cross-origin hop the request's
          // origin is tainted, and this probe measures redirects, not CORS.
          if (url.pathname === '/final') return new Response('final', { headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' } })
          return new Response('none', { status: 404, headers: cors })
        })
        const win = new BrowserWindow({ show: false, webPreferences: { partition: 'orivon-e2e-protocol-probe', offscreen: true } })
        const withViolations = (body: string): string => '(async () => { const v = []; ' +
          "document.addEventListener('securitypolicyviolation', (e) => v.push(e.violatedDirective + ' <- ' + e.blockedURI)); " +
          `const r = await (async () => { ${body} })(); await new Promise((s) => setTimeout(s, 500)); return { r, v } })()`
        /** Never lets one hung step hang the phase: a timeout is itself a measurement. */
        const bounded = async <T>(work: Promise<T>, ms: number, label: string): Promise<T | string> => await Promise.race([
          work.catch((error: unknown) => `${label} threw ${String(error)}`),
          new Promise<string>((resolve) => setTimeout(() => { resolve(`${label} timed out`) }, ms))
        ])
        /** Loads a probe page under `csp`, then runs `body` there; `seen` is only what `body` caused. */
        const measure = async (csp: string, body: string): Promise<{ result: unknown, seen: Seen[] }> => {
          const loaded = await bounded(win.loadURL(`${PAGE}/?csp=${encodeURIComponent(csp)}`), 10_000, 'loadURL')
          if (typeof loaded === 'string') return { result: loaded, seen: [] }
          const mark = seen.length
          const result = await bounded(win.webContents.executeJavaScript(withViolations(body)) as Promise<unknown>, 10_000, 'executeJavaScript')
          return { result, seen: seen.slice(mark) }
        }
        const bothHops = "default-src 'self'; connect-src https://hop-a.orivon.test https://hop-b.orivon.test"
        const hopAOnly = "default-src 'self'; connect-src https://hop-a.orivon.test"
        const wssBody = "try { const ws = new WebSocket('wss://localhost:8893/'); await new Promise((s) => { ws.onerror = s; ws.onclose = s; setTimeout(s, 1500) }); return 'constructed' } catch (e) { return 'threw ' + e.name }"
        try {
          return {
            follow: await measure(bothHops,
              "const res = await fetch('https://hop-a.orivon.test/hop', { headers: { authorization: 'Bearer secret' } }); return { status: res.status, url: res.url, redirected: res.redirected, text: await res.text() }"),
            manual: await measure(bothHops, "const res = await fetch('https://hop-a.orivon.test/hop', { redirect: 'manual' }); return { type: res.type, status: res.status }"),
            loop: await measure(hopAOnly, "try { const res = await fetch('https://hop-a.orivon.test/loop?n=0'); return 'resolved ' + await res.text() } catch (e) { return 'rejected' }"),
            cspOnHop: await measure(hopAOnly, "try { const res = await fetch('https://hop-a.orivon.test/hop'); return 'resolved ' + res.status } catch (e) { return 'rejected' }"),
            wssFromHttpsHost: await measure("default-src 'self'; connect-src https://localhost:8893", wssBody),
            wssFromHttpsScheme: await measure("default-src 'self'; connect-src https:", wssBody),
            wssFromBareHost: await measure("default-src 'self'; connect-src localhost:8893", wssBody),
            noAcao: await measure(hopAOnly, "try { const res = await fetch('https://hop-a.orivon.test/no-acao'); return 'read ' + await res.text() } catch (e) { return 'rejected' }"),
            preflight: await measure(hopAOnly, "try { const res = await fetch('https://hop-a.orivon.test/final', { method: 'PUT', body: 'x' }); return 'status ' + res.status } catch (e) { return 'rejected' }"),
            redirectBody: await (async () => {
              await measure(bothHops, "const res = await fetch('https://hop-a.orivon.test/hop-stream'); return res.status")
              await new Promise((resolve) => setTimeout(resolve, 1000))
              return { ...redirectBody }
            })()
          }
        } finally {
          win.destroy()
          probeSession.protocol.unhandle('https')
        }
      })
      console.log(JSON.stringify({ measured, wssAccepts: wssProbe.count() }, null, 2))
      type Measured = { result: { r: unknown, v: string[] }, seen: Array<{ method: string, url: string, authorization: string | null, origin: string | null }> }
      const m = measured as unknown as Record<'follow' | 'manual' | 'loop' | 'cspOnHop' | 'wssFromHttpsHost' | 'wssFromHttpsScheme' | 'wssFromBareHost', Measured>
      const follow = m.follow.result.r as { status: number, url: string, redirected: boolean, text: string }
      const detail = JSON.stringify(measured)
      const finalHop = m.follow.seen.find((entry) => entry.url === 'https://hop-b.orivon.test/final' && entry.method === 'GET')

      check('a 3xx a protocol.handle handler returns is followed by the page\'s own loader, not handed back as a raw 3xx',
        follow.status === 200 && follow.text === 'final' && follow.redirected && follow.url === 'https://hop-b.orivon.test/final', detail)
      check('the followed hop re-enters the SAME handler -- so a reach redirect is re-authorised per hop', finalHop !== undefined, detail)
      check('Chromium drops Authorization on the cross-origin hop', finalHop !== undefined && finalHop.authorization === null, detail)
      check('redirect: \'manual\' yields an opaque redirect and the handler never sees the target',
        (m.manual.result.r as { type: string }).type === 'opaqueredirect' && m.manual.seen.length === 1, detail)
      check('MEASURED: the page\'s loader applies NO redirect cap to a protocol.handle response -- 60 hops resolve -- so the handler must cap hops itself',
        m.loop.result.r === 'resolved end' && m.loop.seen.length === 61, detail)
      for (const name of ['wssFromHttpsHost', 'wssFromHttpsScheme', 'wssFromBareHost'] as const) {
        check(`MEASURED: a wss: WebSocket is refused by connect-src under ${name} -- neither https:// sources nor bare host:port admit wss: from an https page`,
          m[name].result.v.some((entry) => entry.startsWith('connect-src <- wss:')), detail)
      }
      check('and no wss: attempt reached the network', wssProbe.count() === 0, `accepted=${String(wssProbe.count())}`)
      check('connect-src is re-checked against the redirect target: a hop to an unlisted host is refused before the handler sees it',
        m.cspOnHop.result.r === 'rejected' && m.cspOnHop.result.v.some((entry) => entry.startsWith('connect-src')) &&
          !m.cspOnHop.seen.some((entry) => entry.url.includes('hop-b')), detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
