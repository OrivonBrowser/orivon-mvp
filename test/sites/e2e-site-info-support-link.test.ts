// The site-info popover offers "Report a problem" when the site's manifest names `support.issues`,
// opens it in a new tab, and shows nothing for a manifest that names none. Both sites are
// registered through the developer-only grant hook, which is how the e2e suite gives a loopback
// origin a manifest.
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/sites/e2e-site-info-support-link.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const SUPPORT_URL = 'https://support.example.test/issues/new?app=Fixture'

async function startFixtureServer (): Promise<{ server: Server, url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>fixture-support</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a port')
  return { server, url: `http://127.0.0.1:${String(address.port)}/` }
}

function findPopup (app: ElectronApplication): Page | undefined {
  return app.windows().find((w) => w.url().includes('/site-info/'))
}

async function registerWithManifest (app: ElectronApplication, origin: string, support: { issues: string } | undefined): Promise<boolean> {
  const manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.fixture.support-link',
    name: 'Support Link Fixture',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { fs: { quotaBytes: 1024 } },
    ...(support === undefined ? {} : { support })
  }
  return await app.evaluate(async (_electron, request) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: unknown) => Promise<unknown> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook({ origin: request.origin, manifest: request.manifest, capability: 'fs', patterns: [] })
    return true
  }, { origin, manifest })
}

async function openPanelOf (app: ElectronApplication, chrome: Page, url: string, support: { issues: string } | undefined, check: (name: string, ok: boolean, detail?: string) => void): Promise<Page> {
  await clickAddressBarRetrying(chrome, url)
  const navigated = await waitForTab(chrome, { address: url, title: 'fixture-support' })
  check(`the fixture tab at ${url} navigated`, navigated.ok, JSON.stringify(navigated.info))
  const registered = await registerWithManifest(app, new URL(url).origin, support)
  check('the developer-only grant hook is installed in this build', registered)
  if (!registered) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
  await chrome.click('#reload')
  await waitForTab(chrome, { address: url, title: 'fixture-support' })
  await chrome.waitForTimeout(1_000)
  await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 8_000)
  await chrome.click('#site-permissions-btn')
  await waitFor(() => findPopup(app) !== undefined, 5_000)
  const popup = findPopup(app)
  if (popup === undefined) throw new Error('site-info popup did not open')
  await waitFor(async () => (await popup.$$('.switch')).length > 0, 5_000)
  return popup
}

it(
  '[app:manifest-support-link-in-site-panel] the site panel shows "Report a problem" for a manifest that names support.issues, opens it in a new tab, and shows nothing for one that does not',
  async () => {
    await runPhase('site-info-support-link', async (check) => {
      const withSupport = await startFixtureServer()
      const without = await startFixtureServer()
      let app: ElectronApplication | undefined
      try {
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
        const running = app
        const chrome = await (async () => {
          await waitFor(() => { try { findChrome(running); return true } catch { return false } })
          return findChrome(running)
        })()
        await waitForAddressBarStable(chrome)

        // ---- a manifest with no support: no row ---------------------------
        const plain = await openPanelOf(running, chrome, without.url, undefined, check)
        await plain.waitForTimeout(ABSENCE_SETTLE_MS)
        const stillOpen = !plain.isClosed()
        check('the panel of the manifest with no support is still open when it is read', stillOpen)
        check('a manifest that names no support shows no "Report a problem"', stillOpen && (await plain.$$('#report-problem')).length === 0)
        if (findPopup(running) !== undefined) await chrome.click('#site-permissions-btn')
        await waitFor(() => findPopup(running) === undefined, 5_000)

        // ---- a manifest with support.issues: the row, then the tab --------
        const popup = await openPanelOf(running, chrome, withSupport.url, { issues: SUPPORT_URL }, check)
        const shown = await waitFor(async () => (await popup.$$('#report-problem')).length === 1, 5_000)
        check('a manifest that names support.issues shows one "Report a problem" row', shown)
        check('the row reads "Report a problem"', (await popup.textContent('#report-problem'))?.trim() === 'Report a problem')
        await popup.click('#report-problem')
        const opened = await waitForTab(chrome, { address: SUPPORT_URL })
        check('the row opened the publisher\'s address in the tab in front', opened.ok, JSON.stringify(opened.info))
        check('the popup closed behind it', await waitFor(() => findPopup(running) === undefined, 5_000))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        await new Promise<void>((resolve) => { withSupport.server.close(() => { resolve() }) })
        await new Promise<void>((resolve) => { without.server.close(() => { resolve() }) })
      }
    })
  },
  90_000 + APP_CLOSE_RACE_MS
)
