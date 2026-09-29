// End to end proof of main-world-socket.ts's own extension-code refusal
// (that file's README.md Design notes) against a real Chrome extension in
// real Electron: test/apps/extensions/orivon-caller/ puts window.orivon.
// app.manifest() calls in the page's main world three ways -- a "world":
// "MAIN" content script, an isolated content script's web-accessible
// injected <script>, and a service worker's chrome.scripting.
// executeScript({ world: 'MAIN' }) -- against a GRANTED fixture origin,
// and each must be refused while the page's own call succeeds. Also proves
// the CSP half (src/loader/serve/csp.ts, owner 2026-09-29): a granted
// page's inline <script> does not run at all, only its external one does.
//
// PORTS: an ephemeral one (see startFixtureServer's own comment for why).
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-orivon-filter.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURES_DIR = fileURLToPath(new URL('./apps/extensions/', import.meta.url)).replace(/[/\\]$/, '')
const SLOT = 'orivon-caller'

/** Mirrors test/e2e-extensions-load.test.ts's own seedExtensions, narrowed to this one fixture: see that file for the full mechanism this replays. */
function seedExtension (userDataDir: string): void {
  const sourceDir = join(FIXTURES_DIR, SLOT)
  const rawManifest: unknown = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`fixture ${SLOT}'s own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, SLOT)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', SLOT, parsed.facts.version)
  cpSync(sourceDir, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  const entry: InstalledExtension = {
    id: generateId(key),
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: sourceDir },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
}

/**
 * External, never inline (CSP's own point): the page's own comparison
 * calls, run on every /orivon-fixture/* path. Alongside the plain call,
 * the page's OWN `eval` and `new Function` -- proving bypass 3's fix
 * (main-world-socket.ts's README.md Design notes) narrows page attribution
 * to fileName/eval-origin only WITHOUT also refusing a page's genuine use
 * of either.
 */
const PAGE_JS = `(async () => {
  function outcomeOf (error) {
    return (error && typeof error === 'object' && typeof error.code === 'string') ? error.code : String(error)
  }
  async function run (name, fn) {
    try {
      await fn()
      document.documentElement.setAttribute('data-orivon-' + name, 'allowed')
    } catch (error) {
      document.documentElement.setAttribute('data-orivon-' + name, outcomeOf(error))
    }
  }
  await run('page', () => window.orivon.app.manifest())
  await run('page-eval', () => eval('window.orivon.app.manifest()'))
  await run('page-newfunction', () => (new Function('return window.orivon.app.manifest()'))())
})()`

function page (): string {
  return '<!doctype html><html><head><title>orivon-fixture</title>' +
    // Never runs under the granted CSP (no 'unsafe-inline') -- the test
    // asserts window.__inlineRan stays undefined.
    '<script>window.__inlineRan = true</script>' +
    '<script src="/orivon-fixture/page.js"></script>' +
    '</head><body>orivon-fixture</body></html>'
}

/** A plain, single-page HTTP origin on an EPHEMERAL port -- test/e2e-extensions-load.test.ts's own header explains why never a fixed one. */
async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/orivon-fixture/page.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(PAGE_JS)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page())
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.extensions-orivon-filter-e2e',
  name: 'Extensions orivon-filter e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: {}
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const WAIT_BUDGET_MS = 8_000 + 8_000 + 20_000 + 20_000
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 40_000

it('refuses window.orivon to a MAIN-world content script, an injected web-accessible script, chrome.scripting.executeScript, a //# sourceURL=-spoofed ' +
  'string timer and a deferred bound call, refuses every call once the extension freezes Error.stackTraceLimit, and lets the page\'s own script ' +
  '(including its own eval and new Function) through -- while the CSP change blocks the page\'s own inline script and admits its external one', async () => {
  const started = await startFixtureServer()
  server = started.server
  const origin = started.origin

  await runPhase('window.orivon refuses extension-code callers', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { seedExtension(dir) }
      })

      const loaded = await waitFor(async () => (await (app as NonNullable<typeof app>).evaluate(
        ({ session }) => session.defaultSession.extensions.getAllExtensions().length
      )) === 1)
      check('the fixture extension is loaded into session.defaultSession at boot', loaded)

      // Granted BEFORE navigation, as every other capability e2e does it
      // (e2e-fetch-routing.test.ts's own header): registerApp is what
      // orivon.app.manifest() itself needs, and what makes this origin's
      // CSP the granted-without-'unsafe-inline' one (defaultSessionGranted
      // OriginCsp reads broker.app.hasGrantsSync).
      const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return false
        await hook(request)
        return true
      }, { origin, manifest: MANIFEST, capability: 'id', patterns: [] } satisfies DevGrantRequest)
      check('the developer-only grant hook is installed (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)', granted)
      if (!granted) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

      // ---- baseline: page succeeds; MAIN-world CS, injected script and chrome.scripting are all refused ----
      const view = await navigateToFixture(app, `${origin}/orivon-fixture/`, 'orivon-fixture')
      const baseline = await waitFor(async () => await evaluateRetrying(view, () => {
        const d = document.documentElement.dataset
        return d.orivonPage !== undefined && d.orivonMainWorld !== undefined && d.orivonInjected !== undefined && d.orivonScripting !== undefined &&
          d.orivonPageEval !== undefined && d.orivonPageNewfunction !== undefined
      }))
      check('the page, the MAIN-world content script, the injected script and chrome.scripting all reported an outcome', baseline)
      const outcomes = await evaluateRetrying(view, () => ({ ...document.documentElement.dataset }))
      check('the page\'s own call succeeds', outcomes.orivonPage === 'allowed', JSON.stringify(outcomes))
      check('the page\'s own eval(...) call succeeds -- bypass 3\'s fix does not also refuse genuine page eval', outcomes.orivonPageEval === 'allowed', JSON.stringify(outcomes))
      check('the page\'s own new Function(...) call succeeds -- same as above', outcomes.orivonPageNewfunction === 'allowed', JSON.stringify(outcomes))
      check('the "world": "MAIN" content script is refused with the denied shape', outcomes.orivonMainWorld === 'denied', JSON.stringify(outcomes))
      check('the isolated content script\'s web-accessible injected <script> is refused with the denied shape', outcomes.orivonInjected === 'denied', JSON.stringify(outcomes))
      check('chrome.scripting.executeScript({ world: "MAIN" }) is refused with the denied shape', outcomes.orivonScripting === 'denied', JSON.stringify(outcomes))
      const inlineRan = await evaluateRetrying(view, () => (window as unknown as { __inlineRan?: boolean }).__inlineRan)
      check('CSP: the granted page\'s own inline <script> never ran (no \'unsafe-inline\')', inlineRan === undefined, String(inlineRan))

      // ---- bypass 3: a //# sourceURL=<page-origin>/... comment on a STRING timer scheduled by extension code must still refuse ----
      const sourceUrlView = await navigateToFixture(app, `${origin}/orivon-fixture/sourceurl`, 'orivon-fixture')
      const sourceUrlSettled = await waitFor(async () => await evaluateRetrying(sourceUrlView, () => document.documentElement.dataset.orivonSourceurl) !== undefined)
      check('the sourceURL-spoofed string timer settles', sourceUrlSettled)
      const sourceUrlOutcome = await evaluateRetrying(sourceUrlView, () => document.documentElement.dataset.orivonSourceurl)
      check('a //# sourceURL=-spoofed string timer scheduled by extension code is refused with the denied shape', sourceUrlOutcome === 'denied', String(sourceUrlOutcome))

      // ---- a deferred bound call, scheduled by the MAIN-world content script ----
      const deferredView = await navigateToFixture(app, `${origin}/orivon-fixture/deferred`, 'orivon-fixture')
      const deferredOutcome = await waitFor(async () => await evaluateRetrying(deferredView, () => document.documentElement.dataset.orivonDeferred) !== undefined)
      check('a deferred bound call (setTimeout(orivon.x.bind(...))) settles', deferredOutcome)
      const deferred = await evaluateRetrying(deferredView, () => document.documentElement.dataset.orivonDeferred)
      check('a deferred bound call scheduled by extension code is refused with the denied shape', deferred === 'denied', String(deferred))

      // ---- the extension freezes Error.stackTraceLimit at document_start: every call on this page refuses, the page's own included ----
      const tamperView = await navigateToFixture(app, `${origin}/orivon-fixture/tamper`, 'orivon-fixture')
      const tamperSettled = await waitFor(async () => await evaluateRetrying(tamperView, () => {
        const d = document.documentElement.dataset
        return d.orivonTamperExtension !== undefined && d.orivonPage !== undefined
      }))
      check('both the tampering extension call and the page\'s own call settle', tamperSettled)
      const tamperOutcomes = await evaluateRetrying(tamperView, () => ({ ...document.documentElement.dataset }))
      check('the tampering extension\'s own call is refused too (it does not exempt itself)', tamperOutcomes.orivonTamperExtension === 'denied', JSON.stringify(tamperOutcomes))
      check(
        'freezing Error.stackTraceLimit refuses the PAGE\'s own call as well -- the tamper poisons the shared mechanism, not just the extension\'s attribution',
        tamperOutcomes.orivonPage === 'denied',
        JSON.stringify(tamperOutcomes)
      )
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
