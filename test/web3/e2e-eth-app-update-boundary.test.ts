// What stays out while a name has moved and nobody has answered: an installed app keeps running from its
// pin. A link from another page into the app's address loads the pinned build, so the gateway is never
// asked for the new build's page or scripts, and the app's service worker, asked to update, is not
// served the new build's worker. Only the new manifest is fetched, to make the offer.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { delay, findChrome, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { BUILTIN_ADDRESSES } from '../../src/protocols/builtin.js'
import { answerAccepting, answerQuestion, noNativeDialogs, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { updateApp } from '../apps/app-update/site.mjs'
import { buildsAt, eventually, launchPhase, pinOf, profileOf, startRig } from './app-update-support.js'

const ORIGIN = 'https://app.eth'
const SHOWN = BUILTIN_ADDRESSES.displayUrl(`${ORIGIN}/`)
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS * 3 + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What the app page's own worker reports, asked from main so the page's world is the app's. */
async function workerSays (app: ElectronApplication, call: string): Promise<string> {
  return await app.evaluate(async ({ webContents }, { url, expression }) => {
    const tab = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === url).sort((a, b) => b.id - a.id)[0]
    if (tab === undefined) return 'no tab'
    try {
      return String(await Promise.race([tab.executeJavaScript(expression), new Promise((resolve) => { setTimeout(resolve, 15_000, 'no answer in 15 s') })]))
    } catch (error) {
      return `threw ${String(error)}`
    }
  }, { url: `${ORIGIN}/`, expression: call })
}

it('keeps the new build out of a link into the app and out of its service worker while the offer is open', async () => {
  await runPhase('eth-app-update-boundary', async (check) => {
    const rig = await startRig({
      b: updateApp({ version: '1.0.1', build: 'B', net: true, domain: 'app.eth' }),
      c: updateApp({ version: '2.0.0', build: 'C', net: true, domain: 'other.eth' })
    }, { b: 3, c: 3 })
    const linking = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>link page</title><body><a id="go" href="${ORIGIN}/">go</a> <a id="go-shown" href="ipfs://app.eth/">go</a></body>`) })
    await new Promise<void>((resolve) => { linking.listen(0, '127.0.0.1', resolve) })
    const linkingUrl = `http://127.0.0.1:${String((linking.address() as AddressInfo).port)}/`
    const asked = (cid: string): boolean => rig.gateway.requests.some((request) => request.includes(cid))
    try {
      // Phase 1: build B installs, and its worker takes control.
      let app = await launchPhase(rig, { names: { 'app.eth': 'b' } })
      await stubNativeDialogs(app)
      await clickAddressBarRetrying(findChrome(app), `${ORIGIN}/`)
      check('build B loads', (await waitForTab(findChrome(app), { address: SHOWN, title: 'update fixture B' })).ok)
      await answerAccepting(app)
      check('build B is pinned', await eventually(() => pinOf(app, ORIGIN)?.content?.cid === rig.gateway.roots['b'], 25_000))
      check('the app tab runs build B from its pin', await eventually(async () => (await buildsAt(app, `${ORIGIN}/`)).join() === 'B', 20_000))
      const registered = await workerSays(app, 'window.askWorkerBuild()')
      check(`its service worker registers and reports build B (${registered})`, registered === 'B')
      const profile = profileOf(app)
      await closeElectronApp(app, APP_CLOSE_RACE_MS, { keepProfile: true })

      // Phase 2: the name points at build C. A link from another page opens the app.
      rig.gateway.requests.length = 0
      app = await launchPhase(rig, { names: { 'app.eth': 'c' }, reuse: profile })
      await stubNativeDialogs(app)
      const view = await navigateToFixture(app, linkingUrl, 'link page')
      await view.click('#go')
      check('the link opens the app at build B', (await waitForTab(findChrome(app), { address: SHOWN, title: 'update fixture B' })).ok)
      await answerQuestionIfAsked(app)
      await delay(2_000)
      check('the page shown is build B', (await buildsAt(app, `${ORIGIN}/`)).join() === 'B')

      // The same link written as the address bar shows it.
      const again = await navigateToFixture(app, linkingUrl, 'link page')
      await again.click('#go-shown')
      check('a link written ipfs://app.eth/ opens the app at build B', (await waitForTab(findChrome(app), { address: SHOWN, title: 'update fixture B' })).ok)
      await delay(2_000)
      check('that page is build B too', (await buildsAt(app, `${ORIGIN}/`)).join() === 'B')
      for (const path of ['index.html', 'app.js', 'sw.js']) {
        check(`the gateway was never asked for build C's ${path}`, !asked(rig.gateway.blockOf('c', path)))
      }
      check('the new manifest was fetched, to make the offer', rig.gateway.requests.length > 0)

      const before = await workerSays(app, 'window.askWorkerBuild()')
      const updated = await workerSays(app, 'window.updateWorker()')
      await delay(1_500)
      const after = await workerSays(app, 'window.askWorkerBuild()')
      check(`the worker reports build B before and after an update check (${before}, ${updated}, ${after})`, before === 'B' && after === 'B')
      check('build C\'s worker was never requested', !asked(rig.gateway.blockOf('c', 'sw.js')))
      check('the pin still holds build B', pinOf(app, ORIGIN)?.content?.cid === rig.gateway.roots['b'])
      expect(await noNativeDialogs(app)).toEqual([])
      await closeElectronApp(app)
    } finally {
      await rig.close()
      linking.close()
    }
  })
}, TEST_TIMEOUT_MS)

/** The notice that the offer is not verified: answered once it has appeared. */
async function answerQuestionIfAsked (app: ElectronApplication): Promise<void> {
  await waitQuestion(app, 40_000)
  await answerQuestion(app, 'OK')
}

