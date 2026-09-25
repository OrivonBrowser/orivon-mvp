// A registered app tab has the `buffer` package as its `Buffer` global when
// the page's FIRST inline <head> script runs, under a page CSP that refuses
// eval; the page can replace, shadow and delete it (ADR-0021); it is the
// very class the shim's own `buffer` module exports, so instanceof agrees;
// and an ordinary website, opened in the same tab afterwards, has none.
//
// The fixture origin is registered through the developer-only grant hook
// before navigating, as e2e-app-loader-journey.test.ts does and for the same
// reason: the app-tab flag is fixed when the tab's view is built.
//
// Hermetic: two throwaway servers on loopback ports the OS picks.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, findChrome, findViewShowing, waitForTab } from './smoke-helpers.mjs'
import { clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_TITLE = 'page buffer fixture'
const SITE_TITLE = 'ordinary site fixture'
const NONCE = 'b0ffer'
/** No 'unsafe-eval' and no 'unsafe-inline': only the nonce'd scripts below run, and eval is refused. */
const STRICT_CSP = `script-src 'nonce-${NONCE}'`

const FIRST = `window.__first = (() => {
  const B = window.Buffer
  const d = Object.getOwnPropertyDescriptor(window, 'Buffer')
  let evalAllowed = true
  try { new Function('return 1')() } catch { evalAllowed = false }
  return {
    type: typeof B,
    descriptor: d === undefined ? null : { data: 'value' in d, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable },
    hex: typeof B === 'function' ? B.from('hi').toString('hex') : null,
    base64: typeof B === 'function' ? B.from('aGk=', 'base64').toString() : null,
    isUint8Array: typeof B === 'function' && B.alloc(1) instanceof Uint8Array,
    evalAllowed
  }
})()`

// Bundled into the page as an app's bundler would put the shim's `buffer` module there.
const SHIM_ENTRY = `import shimModule, { Buffer as ShimBuffer } from './src/shim/polyfills/buffer.js'
const PageBuffer = (window as unknown as { Buffer?: typeof ShimBuffer }).Buffer
;(window as unknown as { __identity: unknown }).__identity = typeof PageBuffer !== 'function' ? null : {
  same: ShimBuffer === PageBuffer,
  defaultExportSame: shimModule.Buffer === PageBuffer,
  shimMadeIsPage: ShimBuffer.from([1]) instanceof PageBuffer,
  pageMadeIsShim: PageBuffer.from([1]) instanceof ShimBuffer
}`

const REPLACE = `window.__replace = (() => {
  const original = window.Buffer
  const r = {}
  window.Buffer = 'assigned'
  r.assigned = window.Buffer === 'assigned'
  window.Buffer = original
  try {
    (function () { 'use strict'; function Surrogate () {} Surrogate.prototype = window; const s = new Surrogate(); s.Buffer = 'shadow'; r.shadowed = s.Buffer === 'shadow' && window.Buffer === original })()
  } catch (e) { r.shadowed = String(e) }
  r.deleted = delete window.Buffer && typeof window.Buffer === 'undefined'
  window.Buffer = original
  return r
})()`

const script = (body: string): string => `<script nonce="${NONCE}">${body}</script>`
const APP_PAGE = `<!doctype html><html><head>${script(FIRST)}<script nonce="${NONCE}" src="/shim-buffer.js"></script>${script(REPLACE)}` +
  `<title>${APP_TITLE}</title></head><body>${APP_TITLE}</body></html>`
const SITE_PAGE = `<!doctype html><html><head><script>window.__first = { type: typeof window.Buffer, process: typeof window.process }</script>` +
  `<title>${SITE_TITLE}</title></head><body>${SITE_TITLE}</body></html>`

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.page-buffer-e2e',
    name: 'Page Buffer e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: ['shim-buffer.js'],
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
}

async function listen (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server, origin: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }
}

/** Registers `origin` with an empty grant, so its tab is an app tab and still holds no capability. */
async function register (app: ElectronApplication, origin: string): Promise<boolean> {
  return await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook(request)
    return true
  }, { origin, manifest: manifest(), capability: 'tcp.connect', patterns: [] } satisfies DevGrantRequest)
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

it('gives a registered app tab the buffer package as its Buffer global before its first script, and an ordinary site none', async () => {
  await runPhase('page Buffer global', async (check) => {
    const shimBundle = (await esbuild.build({
      stdin: { contents: SHIM_ENTRY, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'shim-buffer-entry.ts' },
      bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'silent'
    })).outputFiles[0]?.text ?? ''
    const appServer = await listen((req, res) => {
      if (req.url === '/shim-buffer.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        res.end(shimBundle)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': STRICT_CSP })
      res.end(APP_PAGE)
    })
    const siteServer = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SITE_PAGE)
    })
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const registered = await register(app, appServer.origin)
      check('the developer-only grant hook is installed (npm run test:e2e builds with it)', registered)
      if (!registered) return

      const appUrl = `${appServer.origin}/`
      const view = await navigateToFixture(app, appUrl, APP_TITLE)
      const first = await evaluateRetrying(view, () => (window as unknown as { __first: Record<string, unknown> }).__first)
      check('the page CSP refuses eval, so nothing below depends on it', first.evalAllowed === false, JSON.stringify(first))
      check('Buffer is defined when the first inline <head> script runs', first.type === 'function', JSON.stringify(first))
      check('it is the buffer package, working', first.hex === '6869' && first.base64 === 'hi' && first.isUint8Array === true, JSON.stringify(first))
      check('it carries Node\'s descriptor: a writable, configurable, non-enumerable data property',
        JSON.stringify(first.descriptor) === JSON.stringify({ data: true, writable: true, enumerable: false, configurable: true }),
        JSON.stringify(first.descriptor))

      const identity = await evaluateRetrying(view, () => (window as unknown as { __identity: Record<string, boolean> | null }).__identity)
      check('the shim\'s buffer module exports the very same class, so instanceof agrees both ways',
        identity !== null && Object.values(identity).every((v) => v), JSON.stringify(identity))

      const replaced = await evaluateRetrying(view, () => (window as unknown as { __replace: Record<string, unknown> }).__replace)
      check('the page can assign over it, shadow it in strict mode, and delete it (ADR-0021)',
        replaced.assigned === true && replaced.shadowed === true && replaced.deleted === true, JSON.stringify(replaced))

      const siteUrl = `${siteServer.origin}/`
      const chrome = findChrome(app)
      await clickAddressBarRetrying(chrome, siteUrl)
      const reached = await waitForTab(chrome, { address: siteUrl, title: SITE_TITLE })
      const site = findViewShowing(app, chrome, siteUrl)
      check('the same tab reaches an ordinary site', reached.ok && site !== undefined, JSON.stringify(reached.info))
      if (site === undefined) return
      const siteFirst = await evaluateRetrying(site, () => (window as unknown as { __first: Record<string, unknown> }).__first)
      check('an ordinary site gets no Buffer global, and no process either', siteFirst.type === 'undefined' && siteFirst.process === 'undefined', JSON.stringify(siteFirst))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await Promise.all([appServer.server, siteServer.server].map(async (server) => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) }))
    }
  })
}, TEST_TIMEOUT_MS)
