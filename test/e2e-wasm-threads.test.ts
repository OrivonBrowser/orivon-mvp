// A manifest's `crossOriginIsolated: true` end to end: the pinned bundle's
// documents and workers are served with the two isolation headers, so the
// page gets SharedArrayBuffer, a shared WebAssembly.Memory whose buffer IS
// one, and Atomics.wait in a worker fed that memory -- everything a
// WebAssembly component built with threads needs (ADR-0036). A second
// pinned app without the flag is the control: not isolated, no
// SharedArrayBuffer. And a <webview> still attaches inside an isolated page
// (ADR-0039), since the guest is its own document, not a subresource of the
// isolated one.
//
// Served through the real loader path (src/loader/serve/), never a probe
// partition, so the headers measured are the ones a real app gets.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-wasm-threads.test.ts
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/cache/node-storage.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const ISOLATED_ORIGIN = 'https://wasm-threads-e2e.orivon.test'
const PLAIN_ORIGIN = 'https://wasm-threads-control-e2e.orivon.test'
const WORKER_JS = 'onmessage = (e) => { const a = new Int32Array(e.data); const r = Atomics.wait(a, 0, 0, 300); postMessage(r) }'

function manifestFor (origin: string, isolated: boolean): Manifest {
  return {
    orivonApiVersion: 0,
    id: `app.orivon.${isolated ? 'wasm-threads' : 'wasm-threads-control'}-e2e`,
    name: `WebAssembly threads e2e fixture (${isolated ? 'isolated' : 'control'})`,
    version: '1.0.0',
    entry: 'index.html',
    assets: ['worker.js'],
    capabilities: { web: { embed: { origins: ['*'] } } },
    ...(isolated ? { crossOriginIsolated: true as const } : {})
  }
}

async function pinFixture (userDataDir: string, origin: string, manifest: Manifest): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const title = manifest.crossOriginIsolated === true ? 'isolated fixture' : 'control fixture'
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: '/index.html', content: new TextEncoder().encode(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`) },
    { path: '/worker.js', content: new TextEncoder().encode(WORKER_JS) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What a threaded WebAssembly component needs, measured inside the page. */
interface Isolation {
  readonly headers: string
  readonly workerHeaders: string
  readonly sab: string
  readonly isolated: string
  readonly sharedMemory: string
  readonly workerWait: string
  readonly webview: string
}

async function measure (view: Awaited<ReturnType<typeof navigateToFixture>>): Promise<Isolation> {
  return await evaluateRetrying(view, async () => {
    const attempt = async (run: () => Promise<unknown> | unknown): Promise<string> => {
      try { return String(await run()) } catch (error) { return `threw ${String(error)}` }
    }
    const headersOf = async (path: string): Promise<string> => {
      const response = await fetch(path)
      return [response.headers.get('cross-origin-opener-policy'), response.headers.get('cross-origin-embedder-policy')].join(' | ')
    }
    const headers = await attempt(async () => await headersOf('/'))
    const workerHeaders = await attempt(async () => await headersOf('/worker.js'))
    const sab = await attempt(() => typeof SharedArrayBuffer)
    const isolated = await attempt(() => (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated)
    const sharedMemory = await attempt(() => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer.constructor.name)
    const workerWait = await attempt(async () => await new Promise((resolve) => {
      const worker = new Worker('/worker.js')
      const timer = setTimeout(() => { resolve('timeout') }, 5_000)
      worker.onmessage = (event) => { clearTimeout(timer); resolve(String(event.data)); worker.terminate() }
      worker.onerror = (event) => { clearTimeout(timer); resolve(`error ${String(event.message)}`) }
      worker.postMessage(new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer)
    }))
    const webview = await attempt(async () => await new Promise((resolve) => {
      const el = document.createElement('webview') as HTMLElement & { src: string }
      const timer = setTimeout(() => { resolve('never attached') }, 8_000)
      el.addEventListener('dom-ready', () => { clearTimeout(timer); resolve('attached') })
      el.addEventListener('destroyed', () => { clearTimeout(timer); resolve('destroyed') })
      el.src = 'about:blank'
      document.body.appendChild(el)
    }))
    return { headers, workerHeaders, sab, isolated, sharedMemory, workerWait, webview }
  }, 40_000)
}

it('a pinned bundle declaring crossOriginIsolated gets SharedArrayBuffer and worker Atomics.wait, one without does not, and a <webview> still attaches inside the isolated page', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('cross-origin isolation for WebAssembly threads', async (check) => {
      const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      for (const [origin, isolated] of [[ISOLATED_ORIGIN, true], [PLAIN_ORIGIN, false]] as const) {
        const manifest = manifestFor(origin, isolated)
        await pinFixture(userDataDir, origin, manifest)
        const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return false
          await hook(request)
          return true
        }, { origin, manifest, capability: 'web.embed', patterns: ['*'] } satisfies DevGrantRequest)
        check(`the developer-only grant hook granted ${origin}`, granted)
        const registered = await app.evaluate(async (_electron, target: string) => {
          const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
          if (typeof hook !== 'function') return false
          await hook(target)
          return true
        }, origin)
        check(`the dev-only serve-registration hook registered ${origin}`, registered)
      }

      const isolatedView = await navigateToFixture(app, `${ISOLATED_ORIGIN}/`, 'isolated fixture')
      const found = await measure(isolatedView)
      check('the document and the worker script are served with COOP same-origin and COEP credentialless',
        found.headers === 'same-origin | credentialless' && found.workerHeaders === 'same-origin | credentialless', JSON.stringify(found))
      check('the page is cross-origin isolated and SharedArrayBuffer is a global', found.isolated === 'true' && found.sab === 'function', JSON.stringify(found))
      check('a shared WebAssembly.Memory is backed by a SharedArrayBuffer', found.sharedMemory === 'SharedArrayBuffer', JSON.stringify(found))
      check('a worker fed that memory can Atomics.wait on it (returns "timed-out" after its wait)', found.workerWait === 'timed-out', JSON.stringify(found))
      check('a <webview> still attaches inside the isolated page', found.webview === 'attached', JSON.stringify(found))

      const plainView = await navigateToFixture(app, `${PLAIN_ORIGIN}/`, 'control fixture')
      const control = await measure(plainView)
      check('the control app without the flag gets neither header', control.headers === ' | ' && control.workerHeaders === ' | ', JSON.stringify(control))
      check('the control app is not isolated and has no SharedArrayBuffer global', control.isolated === 'false' && control.sab === 'undefined', JSON.stringify(control))
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
