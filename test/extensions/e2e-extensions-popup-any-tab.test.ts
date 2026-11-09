// An extension's popup opens from the toolbar whatever page is in front, as in Chrome: an ordinary page, the new
// tab page, and an `orivon://` page, which no extension instance tracks. With no tab to name, the popup is
// anchored in the window of the toolbar that was clicked, and its own `chrome.tabs.query({ active: true,
// currentWindow: true })` honestly answers no tab. `chrome.action.openPopup()` does the same. The new tab page
// is a tab like any other, and going back to an ordinary page gives its tab back.
//
// Fixture: test/apps/extensions/action-popup/ (MV3, a popup; no service-worker handlers are used). Run with
// `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-popup-any-tab.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { activeTabInfo, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForStartPageLoaded } from '../support/e2e-helpers.js'
import { closePopup, openExtensionPage, popupView, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 180_000
let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startFixtureServer (): Promise<{ server: Server, url: string }> {
  const created = createServer((_request, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>popup-any-tab-fixture</title><body>page</body>')
  })
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server: created, url: `http://127.0.0.1:${String(address.port)}/` }
}

const popupOf = (app: ElectronApplication, id: string): Page | undefined =>
  app.windows().find((w) => w.url().startsWith(`chrome-extension://${id}/popup.html`))

/** What the popup's own `chrome.tabs.query` answers for the window it hangs under. */
async function activeTabUrls (popup: Page): Promise<string[]> {
  return await evaluateRetrying(popup, async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true })).map((tab) => tab.url ?? ''))
}

it('opens an extension\'s popup from the toolbar over an ordinary page, the new tab page and an Orivon page', async () => {
  const started = await startFixtureServer()
  server = started.server

  await runPhase('extension popup over any page', async (check) => {
    let app: ElectronApplication | undefined
    let id = ''
    try {
      app = await launchElectron({
        appPath: '.', args: [HERMETIC_RESOLVER], env: {}, sandbox: true,
        seedProfile: async (dir) => { id = seedFixture(dir, 'action-popup') }
      })
      const live = app
      await waitFor(async () => (await live.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)
      await waitRecovered(live)
      const chrome = findChrome(live)
      const actionSelector = `#${id}`
      await waitFor(async () => await chrome.evaluate((i: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${i}`) != null, id))

      /** Clicks the toolbar button and answers the popup, once its view is in a window. */
      const clickAction = async (): Promise<Page | undefined> => {
        await chrome.click(actionSelector)
        const opened = await waitFor(async () => popupOf(live, id) !== undefined && await popupView(live, id) !== null)
        return opened ? popupOf(live, id) : undefined
      }
      const front = async (): Promise<string> => String((await activeTabInfo(chrome) as { address?: string }).address)
      /** The tab the toolbar button will name when clicked: -1 once no tab of the extension's instance is in front. */
      const buttonTab = async (): Promise<string | null> => await chrome.evaluate((i: string) =>
        document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${i}`)?.getAttribute('tab') ?? null, id)

      // 1. An ordinary page: the popup opens and its query finds the page.
      await navigateToFixture(live, started.url, 'popup-any-tab-fixture')
      const ordinaryTab = (await activeTabInfo(chrome) as { activeId?: string }).activeId as string
      const overOrdinary = await clickAction()
      check('over an ordinary page the toolbar click opens the popup', overOrdinary !== undefined)
      if (overOrdinary !== undefined) {
        const urls = await activeTabUrls(overOrdinary)
        check('and its query finds that page in front', urls.length === 1 && urls[0] === started.url, JSON.stringify(urls))
      }
      await closePopup(live, id)

      // 2. An Orivon page, which no extension instance tracks: a new tab with the settings page in front.
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('settings') })
      check('the settings page is in front', await waitFor(async () => (await front()).startsWith('orivon://settings')), await front())
      check('and the toolbar button names no tab', await waitFor(async () => await buttonTab() === '-1'), String(await buttonTab()))
      const overSettings = await clickAction()
      check('over an Orivon page the toolbar click opens the popup', overSettings !== undefined)
      check('in the window of the toolbar that was clicked', (await popupView(live, id)) !== null)
      if (overSettings !== undefined) {
        const urls = await activeTabUrls(overSettings)
        check('and its query finds no tab in front', urls.length === 0, JSON.stringify(urls))
      }
      await closePopup(live, id)

      // 3. chrome.action.openPopup() from the extension, with the same page in front.
      const extensionPage = await openExtensionPage(live, id, 'options.html')
      await live.evaluate(async ({ webContents }, wc: number) => {
        await webContents.fromId(wc)?.executeJavaScript('chrome.action.openPopup()', true)
      }, extensionPage)
      const opened = await waitFor(async () => popupOf(live, id) !== undefined && await popupView(live, id) !== null)
      check('chrome.action.openPopup() opens the popup over an Orivon page', opened)
      await closePopup(live, id)

      // 4. The new tab page, a tab the extension's instance tracks: its query finds that page, and not the ordinary one behind.
      await chrome.click('#new-tab')
      await waitForStartPageLoaded(live)
      check('the toolbar button names a tab again', await waitFor(async () => { const named = await buttonTab(); return named !== null && Number(named) >= 0 }), String(await buttonTab()))
      const overNewTab = await clickAction()
      check('over the new tab page the toolbar click opens the popup', overNewTab !== undefined)
      if (overNewTab !== undefined) {
        const urls = await activeTabUrls(overNewTab)
        check('and its query finds that page alone in front', urls.length === 1 && urls[0] !== started.url, JSON.stringify(urls))
      }
      await closePopup(live, id)

      // 5. Back on the ordinary page, the tab is given again.
      await chrome.click(`.tab[data-id="${ordinaryTab}"]`)
      check('the ordinary page is in front again', await waitFor(async () => (await activeTabInfo(chrome) as { activeId?: string }).activeId === ordinaryTab && (await tabIds(chrome)).length === 3))
      const again = await clickAction()
      check('back on the ordinary page the toolbar click opens the popup', again !== undefined)
      if (again !== undefined) {
        const urls = await activeTabUrls(again)
        check('and its query finds the page in front again', urls.length === 1 && urls[0] === started.url, JSON.stringify(urls))
      }

      const output = mainOutput(live)
      check('no click was refused with "Unable to get active tab"', !output.includes('Unable to get active tab'), output.slice(output.indexOf('Unable to get active tab'), output.indexOf('Unable to get active tab') + 300))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
