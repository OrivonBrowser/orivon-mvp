// The site-info popover, end to end: the shield and key open real
// WebContentsView popups over the real IPC pipe, and a switch turned off
// through the popover revokes through the real broker -- not a stub.
// (The claim that a switched-off capability does not reappear as a
// re-consent prompt on the next visit is proven at the loader-unit level
// instead, in src/loader/tests/index.test.ts's `declinedCapabilities`
// suite, against the real `decideAndRoute`: that path only ever triggers
// from a page's own `<link rel="orivon-manifest">` hint, which the plain
// fixture page here does not declare, so an ordinary reload of it never
// reaches the loader at all -- exercising that claim honestly needs a
// real manifest-hint fixture, not the developer-only grant shortcut this
// file uses for everything else.)
//
// Also covers the shield opening the Web3 Score page, and the key
// opening the main page with a real switch rendered from a real grant.
//
// Hermetic: everything it touches is loopback. Uses the developer-only
// grant hook (src/main/dev-grant.ts), same as every other e2e file that
// needs a real, persisted grant with no native dialog to click through.
//
// RUN THIS WITH:
//   npm run test:e2e
// or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-site-info.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startFixtureServer (): Promise<{ server: Server, url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>fixture-a</title><body>fixture A</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a port')
  return { server, url: `http://127.0.0.1:${String(address.port)}/` }
}

/** Popup windows are found by URL, never by `app.windows()` object
 * identity: Playwright returns fresh wrapper objects on every call, so a
 * `!==` comparison against an earlier capture never matches -- the same
 * reason `findViewShowing`/`findChrome` (smoke-helpers.mjs) filter by URL. */
function findPopup (app: ElectronApplication, path: string): Page | undefined {
  return app.windows().find((w) => w.url().includes(path))
}

/** Polls for `findChrome` to succeed, rather than a raw window-count
 * check: right at launch, a window can appear in `app.windows()` before
 * its own `loadFile` navigation has committed, so `w.url()` still reads
 * empty for a moment and a count-only wait can resolve before `findChrome`
 * would actually find it. */
async function waitForChrome (app: ElectronApplication): Promise<Page> {
  await waitFor(() => { try { findChrome(app); return true } catch { return false } })
  return findChrome(app)
}

/**
 * Clicks `#reload` and waits for it to fully settle -- shared by both
 * tests below, each of which grants a capability to an already-open tab
 * and then needs a fresh state push. Granting moves the origin to its own
 * session partition (`tab-view.ts`'s `repartitionView`), which briefly
 * swaps in a fresh `WebContentsView`; `waitForTab` alone still leaves a
 * narrow window where the CHROME's own `currentState` has not yet
 * settled from that second swap, in which a click on the shield or key
 * reaches a toolbar whose `activeTab` still briefly reads as not-ready
 * and silently no-ops (`main.ts`'s click handlers all guard on it) --
 * found by a real, repeatable failure, not by reasoning about the race in
 * advance, so the extra wait is deliberate rather than a superstitious
 * pad.
 */
async function reloadAndSettle (chrome: Page, url: string): Promise<void> {
  await chrome.click('#reload')
  await waitForTab(chrome, { address: url, title: 'fixture-a' })
  await chrome.waitForTimeout(1_000)
}

/** Grants `origin` `fs`, through the developer-only hook -- shared setup
 * for both tests below. */
async function grantFs (app: ElectronApplication, origin: string): Promise<boolean> {
  const manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.fixture.site-info',
    name: 'Site Info Fixture',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { fs: { quotaBytes: 1024 } }
  }
  const outcome = await app.evaluate(async (_electron, request) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: unknown) => Promise<unknown> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook({ origin: request.origin, manifest: request.manifest, capability: 'fs', patterns: [] })
    return true
  }, { origin, manifest })
  return outcome
}

it(
  'a switched-off capability revokes for real, through the real broker',
  async () => {
    await runPhase('site-info-turn-off', async (check) => {
      const { server, url } = await startFixtureServer()
      let app: ElectronApplication | undefined
      try {
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
        const chrome = await waitForChrome(app)

        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, url)
        const navigated = await waitForTab(chrome, { address: url, title: 'fixture-a' })
        check('the fixture tab navigated', navigated.ok, JSON.stringify(navigated.info))

        const origin = new URL(url).origin
        const installed = await grantFs(app, origin)
        check('the developer-only grant hook is installed in this build (npm run test:e2e builds with it)', installed)
        if (!installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        // Force a fresh state push so the toolbar re-queries siteSummaryFor.
        await reloadAndSettle(chrome, url)
        const keyAppeared = await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 8_000)
        check('the key became visible once the site had a grant to show', keyAppeared)

        await chrome.click('#site-permissions-btn')
        const popupOpened = await waitFor(() => findPopup(app as ElectronApplication, '/site-info/') !== undefined, 5_000)
        check('the key opened the site-info popup', popupOpened)
        const popup = findPopup(app, '/site-info/')
        if (popup === undefined) throw new Error('site-info popup did not open')

        const switchAppeared = await waitFor(async () => (await popup.$$('.switch.on')).length > 0, 5_000)
        check('a switch rendered on, matching the real grant', switchAppeared)

        await popup.click('.switch.on')
        await popup.click('button.btn-primary:has-text("Confirm")')

        const reloadBannerShown = await waitFor(async () => (await popup.$$('text=Reload this page to apply updated settings')).length > 0, 5_000)
        check('the reload banner appeared after confirming an off switch', reloadBannerShown)

        const stillOn = await popup.$$('.switch.on')
        check('the popup itself no longer shows the capability as on', stillOn.length === 0)

        // The real proof: read the grant back through window.orivon,
        // exposed to every ordinary tab (src/preload/app.ts) and served
        // from the SAME real broker the popup's own turnOff call just
        // reached -- not the popup's own re-render of itself.
        const view = (app as ElectronApplication).windows().find((w) => w.url() === url)
        if (view === undefined) throw new Error('fixture tab view not found')
        const grantsAfterOff = await view.evaluate(async () => {
          const orivon = (globalThis as unknown as { orivon: { app: { grants: () => Promise<Array<{ capability: string }>> } } }).orivon
          return (await orivon.app.grants()).map((g) => g.capability)
        })
        check(`fs is gone from the real broker's own grant list: ${JSON.stringify(grantsAfterOff)}`, !grantsAfterOff.includes('fs'))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  },
  60_000 + APP_CLOSE_RACE_MS
)

it(
  'the shield opens the Web3 Score page, and the key opens the main page',
  async () => {
    await runPhase('site-info-shield-and-key', async (check) => {
      const { server, url } = await startFixtureServer()
      let app: ElectronApplication | undefined
      try {
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
        const chrome = await waitForChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, url)
        await waitForTab(chrome, { address: url, title: 'fixture-a' })

        const origin = new URL(url).origin
        const installed = await grantFs(app, origin)
        check('the developer-only grant hook is installed in this build', installed)
        await reloadAndSettle(chrome, url)
        await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 8_000)

        await chrome.click('#web3-score-btn')
        const web3Opened = await waitFor(() => findPopup(app as ElectronApplication, '/site-info/') !== undefined, 5_000)
        check('the shield opened the site-info popup', web3Opened)
        const web3Popup = findPopup(app, '/site-info/')
        if (web3Popup === undefined) throw new Error('shield popup did not open')
        const web3Heading = await waitFor(async () => (await web3Popup.$$('text=Web3 Score')).length > 0, 5_000)
        check('it opened straight to the Web3 Score page', web3Heading)

        // Close it, then open the key -> the main page. Past
        // popover-view.ts's REOPEN_DEBOUNCE_MS: a click landing inside
        // this window right after the shield's own close would read as
        // that close's echo, not fresh intent.
        await chrome.click('#web3-score-btn')
        await waitFor(() => findPopup(app as ElectronApplication, '/site-info/') === undefined, 5_000)
        await chrome.waitForTimeout(400)
        await chrome.click('#site-permissions-btn')
        const keyOpened = await waitFor(() => findPopup(app as ElectronApplication, '/site-info/') !== undefined, 5_000)
        check('the key opened the site-info popup', keyOpened)
        const mainPopup = findPopup(app, '/site-info/')
        if (mainPopup === undefined) throw new Error('key popup did not open')
        const switchShown = await waitFor(async () => (await mainPopup.$$('.switch')).length > 0, 5_000)
        check('the main page shows the real grant as a switch', switchShown)
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  },
  60_000 + APP_CLOSE_RACE_MS
)
