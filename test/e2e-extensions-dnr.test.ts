// Applies extensions' declarativeNetRequest rules to real requests.
// Fixture: test/apps/extensions/dnr-blocker/ (a static block rule; its
// service worker adds a dynamic redirect rule and a dynamic modifyHeaders
// rule). Seeded the real way (extensions-fixtures.ts's own doc: registry.json
// + loadableManifest's stripped copy, never session.extensions.loadExtension()
// on the raw source).
//
// The verifier partition header ordering (a .eth request) is unit-tested
// against ../sessions/web-request-compose.ts's own compose function instead
// of a real .eth fixture here: see src/main/sessions/tests/dnr-ordering.test.ts.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-dnr.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/dnr-blocker/', import.meta.url)).replace(/[/\\]$/, '')

function seedDnrBlocker (userDataDir: string): InstalledExtension {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`dnr-blocker fixture's own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const slot = 'dnr-blocker'
  const key = resolveSlotKey(userDataDir, slot)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  const entry: InstalledExtension = {
    id: generateId(key),
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: FIXTURE_DIR },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
  return entry
}

const PAGE_HTML = `<!doctype html>
<title>dnr-fixture</title>
<body>
<script src="/ads/blocked.js" onerror="window.__adBlocked = true"></script>
<script>
window.__pageRan = true
fetch('/from-fixture').then((r) => r.text().then((body) => { window.__redirectBody = body; window.__redirectUrl = r.url })).catch((e) => { window.__redirectError = String(e) })
fetch('/header-me').then((r) => { window.__headerValue = r.headers.get('x-dnr-test') }).catch((e) => { window.__headerError = String(e) })
</script>
</body>`

function startDnrFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE_HTML)
    } else if (url.startsWith('/ads/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__adRan = true;')
    } else if (url.startsWith('/from-fixture')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('not-redirected')
    } else if (url.startsWith('/to-fixture')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('redirected-content')
    } else if (url.startsWith('/header-me')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('header-test')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('dnr fixture server did not report a port'))
        return
      }
      resolve({ server, origin: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const SW_SETTLE_MS = 6_000
const TEST_TIMEOUT_MS = 120_000

it('applies a loaded extension\'s static block rule and its service worker\'s dynamic redirect/modifyHeaders rules to real requests', async () => {
  const started = await startDnrFixtureServer()
  server = started.server
  const fixtureUrl = `${started.origin}/`

  await runPhase('extensions dnr', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { seedDnrBlocker(dir) },
        sandbox: true
      })
      const liveApp = app

      // Give the fixture's service worker time to call updateDynamicRules
      // before any request depends on its rules.
      await new Promise((resolve) => setTimeout(resolve, SW_SETTLE_MS))

      const view = await navigateToFixture(app, fixtureUrl, 'dnr-fixture')

      // ---- the page's own script runs regardless ----
      const pageRan = await waitFor(async () => await evaluateRetrying(view, () => Boolean((window as unknown as { __pageRan?: boolean }).__pageRan)))
      check('the fixture page\'s own inline script ran', pageRan)

      // ---- static block rule: the ad script never runs, and errors loading ----
      const adBlocked = await waitFor(async () => await evaluateRetrying(view, () => Boolean((window as unknown as { __adBlocked?: boolean }).__adBlocked)))
      check('the static rule blocked the /ads/*.js script (its onerror fired)', adBlocked)
      const adRan = await evaluateRetrying(view, () => Boolean((window as unknown as { __adRan?: boolean }).__adRan))
      check('the blocked ad script never actually ran', !adRan)

      // ---- dynamic redirect rule (added by the service worker) ----
      const redirectBody = await waitFor(async () => await evaluateRetrying(view, () => (window as unknown as { __redirectBody?: string }).__redirectBody) === 'redirected-content')
        .then(() => true).catch(() => false)
      const redirectDetail = await evaluateRetrying(view, () => ({
        body: (window as unknown as { __redirectBody?: string }).__redirectBody,
        url: (window as unknown as { __redirectUrl?: string }).__redirectUrl,
        error: (window as unknown as { __redirectError?: string }).__redirectError
      }))
      check('the dynamic redirect rule landed on /to-fixture', redirectBody, JSON.stringify(redirectDetail))

      // ---- dynamic modifyHeaders rule (added by the service worker) ----
      const headerValue = await waitFor(async () => await evaluateRetrying(view, () => (window as unknown as { __headerValue?: string | null }).__headerValue) === '1')
        .then(() => true).catch(() => false)
      check('the dynamic modifyHeaders rule set x-dnr-test on the response', headerValue)

      // ---- a request with no webContents is untouched ----
      const mainProcessFetch = await liveApp.evaluate(async ({ net }, url: string) => {
        try {
          const response = await net.fetch(url)
          return { ok: response.ok, status: response.status }
        } catch (error) {
          return { ok: false, status: 0, error: String(error) }
        }
      }, `${started.origin}/ads/blocked.js`)
      check(
        'a main-process net.fetch to the same blocked-by-rule URL is untouched (no webContents in scope)',
        mainProcessFetch.ok && mainProcessFetch.status === 200,
        JSON.stringify(mainProcessFetch)
      )
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

it('a fresh install through the real install path blocks with no restart (extensions-dnr.ts\'s registerPendingDnrInstall)', async () => {
  let installServer: Server | undefined
  await runPhase('extensions dnr install path', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      // No seedProfile: the whole point is finishInstall's real
      // loadExtension call, not registry.json seeded ahead of boot.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true })
      const liveApp = app

      const outcome = await liveApp.evaluate(async ({ dialog }, dir: string) => {
        // Auto-approve the one consent dialog finishInstall shows -- there
        // is no native dialog for a headless run to click through.
        ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0, checkboxChecked: false })
        const hook = (globalThis as unknown as {
          __orivonDevExtensionsInstall?: { installFromFolder: (dir: string) => Promise<{ installed: boolean }> }
        }).__orivonDevExtensionsInstall
        if (hook === undefined) {
          throw new Error('extensions-install-test-hook.ts\'s seam is not installed -- build with ORIVON_ENABLE_DEV_GRANT=1 (scripts/build-e2e.mjs)')
        }
        return await hook.installFromFolder(dir)
      }, FIXTURE_DIR)
      check('installFromFolder installed the fixture', outcome.installed === true, JSON.stringify(outcome))

      const started = await startDnrFixtureServer()
      installServer = started.server

      // No restart of app between the install above and this navigation:
      // the static block rule must already be live in the SAME process.
      const view = await navigateToFixture(app, `${started.origin}/`, 'dnr-fixture')
      const adBlocked = await waitFor(async () =>
        await evaluateRetrying(view, () => Boolean((window as unknown as { __adBlocked?: boolean }).__adBlocked))
      )
      check('the static block rule already blocks the ad script, with no restart', adBlocked)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (installServer !== undefined) await new Promise<void>((resolve) => { installServer?.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
