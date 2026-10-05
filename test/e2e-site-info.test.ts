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
// Also covers N2's disclosure (docs/planning/extensions-exploration.md):
// with a fixture extension seeded and enabled, the popup's "Extensions on
// this site" section names it, and its "Manage" link opens the real
// orivon://extensions page.
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
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, asPage, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { seedExtensions } from './extensions-fixtures.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from './question-support.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** `setAsPageScript`/`/__as-page-script.js`: asPage's (e2e-helpers.ts) own hook -- window.orivon calls must run as a script the page itself loaded, never through page.evaluate() (ADR-0045). */
async function startFixtureServer (): Promise<{ server: Server, url: string, setAsPageScript: (js: string) => void }> {
  let asPageScript = ''
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/__as-page-script.js') === true) {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(asPageScript)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>fixture-a</title><body>fixture A</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a port')
  return { server, url: `http://127.0.0.1:${String(address.port)}/`, setAsPageScript: (js: string) => { asPageScript = js } }
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
      const { server, url, setAsPageScript } = await startFixtureServer()
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
        const grantsAfterOff = await asPage(view, setAsPageScript, `${url}__as-page-script.js`, async () => {
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
  '[app:granted-capabilities-are-reported] [app:declined-capability-is-refused] a switched-on capability grants for real and asks again only after it was off; the card\'s Reload closes it and the tab keeps its history',
  async () => {
    await runPhase('site-info-turn-on', async (check) => {
      const { server, url, setAsPageScript } = await startFixtureServer()
      let app: ElectronApplication | undefined
      try {
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
        const running = app
        await stubNativeDialogs(running)
        const chrome = await waitForChrome(running)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, url)
        await waitForTab(chrome, { address: url, title: 'fixture-a' })

        const origin = new URL(url).origin
        const installed = await grantFs(running, origin)
        check('the developer-only grant hook is installed in this build', installed)
        if (!installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        await reloadAndSettle(chrome, url)
        await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 8_000)

        const tabView = (): Page => {
          const found = running.windows().find((w) => w.url() === url)
          if (found === undefined) throw new Error('fixture tab view not found')
          return found
        }
        const readFsAttempt = async (): Promise<string> => await asPage(tabView(), setAsPageScript, `${url}__as-page-script.js`, async () => {
          const orivon = (globalThis as unknown as { orivon: { fs: { writeFile: (path: string, data: Uint8Array) => Promise<void> } } }).orivon
          try {
            await orivon.fs.writeFile('h2.txt', new TextEncoder().encode('x'))
            return 'wrote'
          } catch (error) {
            return `refused: ${error instanceof Error ? error.message : String(error)}`
          }
        })
        const history = async (): Promise<{ canGoBack: boolean } | undefined> => await running.evaluate(({ webContents }, start) => {
          const wc = webContents.getAllWebContents().find((c) => c.getURL() === start)
          return wc === undefined ? undefined : { canGoBack: wc.navigationHistory.canGoBack() }
        }, url)
        check('the tab that became an app by the grant kept the page it came from behind it', (await history())?.canGoBack === true)

        // ---- off, through the card ---------------------------------------
        await chrome.click('#site-permissions-btn')
        await waitFor(() => findPopup(running, '/site-info/') !== undefined, 5_000)
        let popup = findPopup(running, '/site-info/')
        if (popup === undefined) throw new Error('site-info popup did not open')
        await waitFor(async () => (await popup?.$$('.switch.on'))?.length === 1, 5_000)
        await popup.click('.switch.on')
        await popup.click('button.btn-primary:has-text("Confirm")')
        await waitFor(async () => (await popup?.$$('.switch.on'))?.length === 0, 5_000)

        const whileOff = await readFsAttempt()
        check(`[app:declined-capability-is-refused] with fs off, the page's own fs call is refused (${whileOff})`, whileOff.startsWith('refused'))
        const askedWhileOff = await asPage(tabView(), setAsPageScript, `${url}__as-page-script.js`, async () => {
          const orivon = (globalThis as unknown as { orivon: { app: { requestGrant: (r: { capability: string }) => Promise<boolean> } } }).orivon
          return await orivon.app.requestGrant({ capability: 'fs' })
        })
        check('[app:declined-capability-is-refused] a request for the capability it was switched off for resolves false with no question', askedWhileOff === false && await questionGone(running))

        // ---- on, through the card ----------------------------------------
        popup = findPopup(running, '/site-info/')
        if (popup === undefined) throw new Error('site-info popup closed')
        await waitFor(async () => (await popup?.$$('.switch:not(.on)'))?.length === 1, 5_000)
        await popup.click('.switch:not(.on)')
        await popup.click('button.btn-primary:has-text("Confirm")')
        const banner = await waitFor(async () => (await popup?.$$('text=Reload this page to apply updated settings'))?.length === 1, 5_000)
        check('the reload banner appears after switching a capability on', banner)
        check('the row now renders on', (await popup.$$('.switch.on')).length === 1)

        const grants = await asPage(tabView(), setAsPageScript, `${url}__as-page-script.js`, async () => {
          const orivon = (globalThis as unknown as { orivon: { app: { grants: () => Promise<Array<{ capability: string }>> } } }).orivon
          return (await orivon.app.grants()).map((g) => g.capability)
        })
        check(`[app:granted-capabilities-are-reported] the real broker holds fs again: ${JSON.stringify(grants)}`, grants.includes('fs'))

        // ---- the card's Reload closes the card, the tab keeps its history -----
        await tabView().evaluate(() => { (window as unknown as Record<string, unknown>)['__beforeReload'] = true })
        await popup.click('button:has-text("Reload")')
        const cardGone = await waitFor(() => findPopup(running, '/site-info/') === undefined, 8_000)
        check('the card closes with the reload it asked for', cardGone)
        const reloaded = await waitFor(async () => {
          try { return !(await tabView().evaluate(() => (window as unknown as Record<string, unknown>)['__beforeReload'] === true)) } catch { return false }
        }, 15_000)
        check('the page reloaded', reloaded)
        await waitForTab(chrome, { address: url, title: 'fixture-a' })
        check('the reloaded tab still has the page it came from behind it', (await history())?.canGoBack === true)

        const afterReload = await readFsAttempt()
        check(`after the reload the page's own fs call succeeds (${afterReload})`, afterReload === 'wrote')

        // The decline was retired by the switch: asking again reaches the person.
        const answered = asPage(tabView(), setAsPageScript, `${url}__as-page-script.js`, async () => {
          const orivon = (globalThis as unknown as { orivon: { app: { requestGrant: (r: { capability: string }) => Promise<boolean> } } }).orivon
          return await orivon.app.requestGrant({ capability: 'fs' })
        })
        const question = await readQuestion(await waitQuestion(running))
        check(`asking for it again reaches the person, in the panel (${JSON.stringify(question.buttons)})`, question.buttons.includes('Allow') && question.buttons.includes('Deny'))
        await tabView().evaluate(() => { location.href = '/held-away' })
        await delay(ABSENCE_SETTLE_MS)
        check('while the question is open the page cannot take its tab elsewhere', running.windows().some((w) => w.url() === url) && !running.windows().some((w) => w.url().includes('/held-away')))
        await answerQuestion(running, 'Deny')
        check('[app:declined-capability-is-refused] and a Deny resolves false', (await answered) === false)
        await tabView().evaluate(() => { location.href = '/after-deny' })
        check('once answered the page can navigate again', await waitFor(() => running.windows().some((w) => w.url() === `${url}after-deny`), 10_000))
        check('no native message box was opened', (await noNativeDialogs(running)).length === 0)
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  },
  90_000 + APP_CLOSE_RACE_MS
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
        // press-stamps.ts's REOPEN_DEBOUNCE_MS: a click landing inside
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

it(
  'N2\'s disclosure: the popup names a seeded extension reaching the site, and Manage opens orivon://extensions',
  async () => {
    await runPhase('site-info-extensions-on-site', async (check) => {
      const { server, url } = await startFixtureServer()
      let app: ElectronApplication | undefined
      try {
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER],
          seedProfile: async (dir) => { seedExtensions(dir) },
          sandbox: true
        })
        const chrome = await waitForChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, url)
        await waitForTab(chrome, { address: url, title: 'fixture-a' })

        // The key's own visibility gates on a held capability (siteSummaryFor's
        // `asked`), same as the other tests in this file -- extensionsOnSite
        // does not widen that gate, so a grant is still what opens the popup.
        const origin = new URL(url).origin
        const installed = await grantFs(app, origin)
        check('the developer-only grant hook is installed in this build', installed)
        await reloadAndSettle(chrome, url)
        await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null, 8_000)

        await chrome.click('#site-permissions-btn')
        const popupOpened = await waitFor(() => findPopup(app as ElectronApplication, '/site-info/') !== undefined, 5_000)
        check('the key opened the site-info popup', popupOpened)
        const popup = findPopup(app, '/site-info/')
        if (popup === undefined) throw new Error('site-info popup did not open')

        const sectionShown = await waitFor(async () => (await popup.$$('text=Extensions on this site')).length > 0, 5_000)
        check('the "Extensions on this site" heading appeared', sectionShown)
        const namesShown = await waitFor(async () =>
          (await popup.$$('text=Orivon E2E Content Marker')).length > 0 &&
          (await popup.$$('text=Orivon E2E Network Perms')).length > 0, 5_000)
        check('both seeded fixture extensions are named -- both declare <all_urls> host access', namesShown)

        await popup.click('button.nav-row:has-text("Manage")')
        const extensionsPageOpened = await waitFor(
          () => (app as ElectronApplication).windows().some((w) => w.url().startsWith('orivon://extensions')),
          5_000
        )
        check('Manage opened the real orivon://extensions page', extensionsPageOpened)
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  },
  60_000 + APP_CLOSE_RACE_MS
)
