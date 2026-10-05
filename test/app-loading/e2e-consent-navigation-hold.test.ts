// A page cannot take its tab away while a question about it is open, and a tab
// that becomes an app keeps its back list.
//
// A loopback origin that carries a manifest hint asks the person for its
// grants in the tab's question panel. While that question is open the page
// tries to leave (location.href), to open a window (window.open) and to route
// itself (history.pushState). The first two must reach nothing: the server
// sees no request for either, the tab count stays and the address is still the
// page's own. The third is not a navigation and still works. After "Allow" the
// tab is rebuilt as the app, the history entry the person came from is still
// behind it, and the page can navigate again.
//
// Hermetic: everything it touches is loopback; the native dialog methods are
// replaced with recorders only to prove none was opened.
//
// RUN THIS WITH: node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-loading/e2e-consent-navigation-hold.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { answerQuestion, noNativeDialogs, stubNativeDialogs, waitQuestion } from '../support/question-support.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000 + APP_CLOSE_RACE_MS

const MANIFEST = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.fixture.navigation-hold',
  name: 'Navigation hold fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: { fs: { quotaBytes: 1024 } }
})

async function startFixture (): Promise<{ server: Server, origin: string, requests: string[] }> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    requests.push(path)
    if (path === '/.well-known/orivon.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(MANIFEST)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    if (path.startsWith('/start')) {
      res.end('<!doctype html><meta charset="utf-8"><title>start</title><body>start</body>')
      return
    }
    res.end('<!doctype html><meta charset="utf-8"><title>fixture</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, requests }
}

async function tabUrl (app: ElectronApplication, prefix: string): Promise<string | undefined> {
  return await app.evaluate(({ webContents }, start) => webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(start))?.getURL(), prefix)
}

it('[app:consent-question-holds-the-page] holds a page where it is while its question is open, then lets the tab become the app with its history intact', async () => {
  await runPhase('consent-navigation-hold', async (check) => {
    const { server, origin, requests } = await startFixture()
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const running = app
      await stubNativeDialogs(running)
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `${origin}/start`)
      await waitFor(async () => (await tabUrl(running, `${origin}/start`)) !== undefined, 15_000)
      await clickAddressBarRetrying(chrome, `${origin}/`)

      const panel = await waitQuestion(running)
      check('the consent question is open in the panel', panel !== undefined)
      const view = findViewShowing(running, chrome, `${origin}/`)
      if (view === undefined) throw new Error('no view showing the fixture page')
      const tabsBefore = (await tabIds(chrome)).length
      const requestsBefore = requests.length

      await view.evaluate(() => {
        window.open('/popup')
        history.pushState({}, '', '/spa')
        location.href = '/elsewhere'
      })
      await delay(ABSENCE_SETTLE_MS)

      const seen = requests.slice(requestsBefore)
      check(`the page's own navigation and its window.open reached no server (${JSON.stringify(seen)})`, !seen.includes('/elsewhere') && !seen.includes('/popup'))
      check('no new tab opened', (await tabIds(chrome)).length === tabsBefore)
      check('the same-document route still worked and the address is the page\'s own', (await tabUrl(running, `${origin}/spa`)) !== undefined, String(await tabUrl(running, origin)))

      await answerQuestion(running, 'Allow')
      const becameApp = await waitFor(async () => {
        const shown = findViewShowing(running, chrome, `${origin}/spa`)
        if (shown === undefined) return false
        try {
          return await shown.evaluate(() => !/\[native code\]/.test(String(globalThis.fetch)))
        } catch {
          return false
        }
      }, 25_000)
      check('after Allow the tab is rebuilt as the app', becameApp)

      const tabHistory = await running.evaluate(({ webContents }, start) => {
        const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(start))
        return wc === undefined ? undefined : { canGoBack: wc.navigationHistory.canGoBack(), urls: wc.navigationHistory.getAllEntries().map((entry) => entry.url) }
      }, origin)
      check(`the rebuilt tab keeps the page the person came from behind it (${JSON.stringify(tabHistory)})`, tabHistory?.canGoBack === true && tabHistory.urls.some((url) => url.endsWith('/start')))

      const appView = findViewShowing(running, chrome, `${origin}/spa`)
      if (appView === undefined) throw new Error('the app view disappeared')
      const before = requests.length
      await appView.evaluate(() => { location.href = '/after' })
      const left = await waitFor(() => requests.slice(before).includes('/after'), 10_000)
      check('once answered, the page can navigate again', left)
      check('no native message box was opened', (await noNativeDialogs(running)).length === 0)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
