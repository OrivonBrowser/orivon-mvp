// An app whose entry is in a subdirectory is opened at its origin root, which the loader answers with a 302. Electron
// hands a page the redirect's headers together with the destination's body on any session with a web-request listener
// (every session of the product), so the redirect has to carry the policy the entry carries: this spec opens the entry
// directly and through `/`, and the document must raise the same CSP violation both ways.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/app-loading/e2e-served-entry-redirect.test.ts
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { bundleTree } from '../../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../../src/loader/cache/node-storage.js'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://served-entry-redirect-e2e.orivon.test'
const INDEX_HTML = '<!doctype html><html><head><title>entry redirect fixture</title></head><body><h1>entry redirect fixture</h1></body></html>'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.served-entry-redirect-e2e',
  name: 'Served entry redirect e2e fixture',
  version: '1.0.0',
  entry: 'app/index.html',
  capabilities: { net: { https: { connect: ['allowed.orivon.test:*'] } } }
}

async function pinFixture (userDataDir: string): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(JSON.stringify(MANIFEST)) },
    { path: '/app/index.html', content: new TextEncoder().encode(INDEX_HTML) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
}

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

it('[app:subdirectory-entry-opened-at-root-keeps-served-policy] an app whose entry is in a subdirectory, opened at its origin root, runs under the same served CSP as when the entry is opened directly', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('subdirectory entry opened through the root redirect', async (check) => {
      const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await pinFixture(userDataDir)
      const hooks = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        const register = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
        if (typeof hook !== 'function' || typeof register !== 'function') return false
        await hook(request)
        await register(request.origin)
        return true
      }, { origin: ORIGIN, manifest: MANIFEST, capability: 'https.connect', patterns: ['allowed.orivon.test:*'] } satisfies DevGrantRequest)
      check('the developer-only grant and serve-registration hooks are installed (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)', hooks)
      if (!hooks) throw new Error('dev hooks missing -- was this built via scripts/build-e2e.mjs?')

      const view = await navigateToFixture(app, `${ORIGIN}/app/index.html`, 'entry redirect fixture')
      /** What this document's served policy refuses: an image from a host the grant does not name. */
      const violations = async (): Promise<string[]> => await evaluateRetrying(view, async () => {
        const seen: string[] = []
        document.addEventListener('securitypolicyviolation', (event) => { seen.push(`${event.violatedDirective} <- ${event.blockedURI}`) })
        await new Promise<void>((resolve) => { const img = new Image(); img.onload = () => { resolve() }; img.onerror = () => { resolve() }; img.src = 'https://elsewhere.orivon.test/x.png' })
        await new Promise((resolve) => setTimeout(resolve, 300))
        return seen
      })
      const direct = await violations()
      check('CONTROL: the entry opened directly refuses an image from a host the grant does not name', direct.some((entry) => entry.startsWith('img-src')), JSON.stringify(direct))

      await view.evaluate(() => { (window as unknown as { __before?: boolean }).__before = true; setTimeout(() => { location.assign('/') }, 50) })
      const reloaded = await waitFor(async () => {
        try { return await view.evaluate(() => (window as unknown as { __before?: boolean }).__before === undefined && location.pathname === '/app/index.html') } catch { return false }
      }, 15_000)
      check('opening `/` loaded a new document at the entry', reloaded)

      const viaRoot = await violations()
      check('the document reached through the `/` redirect refuses the same image under the same served CSP', JSON.stringify(viaRoot) === JSON.stringify(direct), JSON.stringify({ direct, viaRoot }))

      const fetched = await evaluateRetrying(view, async () => {
        const res = await fetch('/')
        return { redirected: res.redirected, csp: res.headers.get('content-security-policy'), nosniff: res.headers.get('x-content-type-options'), type: res.headers.get('content-type') }
      })
      check('a `fetch` of `/` that follows the redirect sees the served policy headers and the entry\'s type',
        fetched.redirected && fetched.csp?.includes("default-src 'self'") === true && fetched.nosniff === 'nosniff' && fetched.type === 'text/html; charset=utf-8', JSON.stringify(fetched))
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
