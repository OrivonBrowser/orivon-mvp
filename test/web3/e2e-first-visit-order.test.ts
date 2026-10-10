// A published app's first visit: the page loads at once as an ordinary website, with no Node globals and no
// grants, while the person is asked as soon as the manifest is read; Allow reloads the tab as the app, with its
// grants, while a file the first page never loads is still undownloaded; Deny leaves the site as the plain website
// it already is and is not asked again. Driven through the test seam's gateway, so nothing leaves the machine.
import { afterAll, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import type { Page } from 'playwright'
import { anyDocumentAt, coverTitle, pageAt, pinPath, savedGrants, withDeclaredTree } from './first-visit-support.js'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  // Listed by the manifest and never loaded by the first page: still undownloaded when the page shows.
  'later.bin': 'x'.repeat(2_000_000),
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'later.bin'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-loads-as-a-website-while-asking] [app:first-visit-enters-at-once] [app:first-visit-deny-is-a-website] loads a first visit as a plain website while it asks, reloads as the app on Allow with the rest of the bundle still undownloaded, and leaves a refused app as the plain website it is', async () => {
  await runPhase('first-visit-order', async (check) => {
    const gateway = await startFixtureGateway({
      allowed: await withDeclaredTree(files('Allowed app', 'first.visit.allowed')),
      refused: await withDeclaredTree(files('Refused app', 'first.visit.refused'))
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const allowedRoot = gateway.roots['allowed']!
      const refusedRoot = gateway.roots['refused']!
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      // 1. The page loads at once as an ordinary website while the question is open.
      const allowedOrigin = `https://${allowedRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${allowedRoot}`)
      const panel = await waitQuestion(running, 60_000)
      const asked = await readQuestion(panel)
      check(`the question names the app (${JSON.stringify(asked.origin)})`, JSON.stringify(asked).includes(allowedRoot))
      const filesAsked = (site: string, path: string): number => gateway.requests.filter((request) => request.startsWith(`/ipfs/${gateway.blockOf(site, path)}`)).length
      let website = null as PageFacts | null
      await waitFor(async () => { website = await pageAt(running, `${allowedOrigin}/`); return website?.ran === 'ran' }, 30_000)
      check(`the page runs as an ordinary website while the question is open: its script ran and it has no Node globals (${JSON.stringify(website)})`, website?.ran === 'ran' && !website.hasProcess)
      check('no setup cover hides the page', (await coverTitle(running)) === null)
      check('nothing is pinned or granted yet', !existsSync(pinPath(userData, allowedOrigin)) && savedGrants(userData, allowedOrigin).length === 0)
      check('a file the first page never loads is still undownloaded', filesAsked('allowed', 'later.bin') === 0)

      // 2. Allow: the tab reloads as the app, with its grants, and the rest of the bundle is still to come.
      await answerQuestion(running, 'Allow')
      const entered = await waitForTab(chrome, { address: `ipfs://${allowedRoot}/`, title: 'Allowed app' }, 60_000)
      check(`the app opened (${JSON.stringify(entered.info)})`, entered.ok)
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${allowedOrigin}/`); return facts?.ran === 'ran' && facts.hasProcess }, 30_000)
      check(`the tab reloaded as an app tab with the Node globals (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('its grants are saved', savedGrants(userData, allowedOrigin).includes('fs'))
      check('a file the first page never loads is still undownloaded while the page shows', filesAsked('allowed', 'later.bin') === 0)
      check('nothing is pinned yet: the rest of the bundle comes later, in the background', !existsSync(pinPath(userData, allowedOrigin)))

      // 3. Deny: a plain website, no Node globals, and not asked again.
      const refusedOrigin = `https://${refusedRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${refusedRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Deny')
      const plain = await waitForTab(chrome, { address: `ipfs://${refusedRoot}/`, title: 'Refused app' }, 60_000)
      check(`the refused site opened (${JSON.stringify(plain.info)})`, plain.ok)
      let refused = null as PageFacts | null
      await waitFor(async () => { refused = await pageAt(running, `${refusedOrigin}/`); return refused?.ran === 'ran' }, 20_000)
      check(`it stays a website: its script ran and it has no Node globals (${JSON.stringify(refused)})`, refused?.ran === 'ran' && !refused.hasProcess)
      check('nothing was pinned or granted for it', !existsSync(pinPath(userData, refusedOrigin)) && savedGrants(userData, refusedOrigin).length === 0)
      await clickAddressBarRetrying(chrome, `ipfs://${refusedRoot}/`)
      await delay(ABSENCE_SETTLE_MS)
      check('visiting it again asks nothing', await questionGone(running))

      // 4. Settings, Sites lists the refusal, and Ask again gives the question back; Escape records nothing.
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('siteSettings.open') })
      const settingsOf = (): Page | undefined => running.windows().find((page) => page.url().startsWith('orivon://settings') && !page.isClosed())
      check('Settings opened', await waitFor(() => settingsOf() !== undefined, 20_000))
      const settings = settingsOf() as Page
      await settings.waitForSelector('#row-sites-list .declined-app', { timeout: 20_000 })
      const listed = await settings.locator('#row-sites-list .declined-app .site-host').allTextContents()
      check(`Settings, Sites lists the refused app (${JSON.stringify(listed)})`, listed.length === 1 && refusedOrigin.endsWith(listed[0] ?? '?'))
      await settings.click('#row-sites-list .declined-app button:text-is("Ask again")')
      check('Ask again takes it off the list', await waitFor(async () => await settings.locator('#row-sites-list .declined-app').count() === 0, 10_000))
      await clickAddressBarRetrying(chrome, `ipfs://${refusedRoot}/`)
      const again = await waitQuestion(running, 60_000)
      check('the next visit asks again', true)
      // The panel closes under the key, which Playwright reports as a closed target.
      await again.keyboard.press('Escape').catch((error: unknown) => { if (!/closed|destroyed/.test(String(error))) throw error })
      // Escape means not now: nothing is written down, and nothing asks again for the rest of this run, however the page is reached.
      await clickAddressBarRetrying(chrome, `ipfs://${refusedRoot}/`)
      await delay(ABSENCE_SETTLE_MS)
      check('Escape means not now for the run: the visit after it asks nothing', await questionGone(running))
      const declinedFile = join(userData, 'declined-apps.json')
      check('Escape recorded nothing', !existsSync(declinedFile) || !readFileSync(declinedFile, 'utf8').includes(refusedRoot))
      const dismissed = await pageAt(running, `${refusedOrigin}/`)
      check(`the page kept running as the website it is (${JSON.stringify(dismissed)})`, dismissed?.ran === 'ran' && !dismissed.hasProcess)

      expect(asked.buttons).toContain('Allow')
      expect(filesAsked('allowed', 'app.js')).toBeGreaterThanOrEqual(1)
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
