// What follows the entry of a published app, in the background: the whole bundle is downloaded and pinned, after
// which a visit is served from the pin with the gateway gone; a file the page never loaded that turns out not to be
// the declared one blocks the app all the same, even though its first page ran fine. Driven through the test
// seam's gateway.
import { afterAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, pageLog, pinPath, pressSheet, savedGrants, sheetGone, waitSheet, watchPages, withDeclaredTree } from './first-visit-support.js'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  'later.js': 'document.title = "never loaded"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'later.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 180_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-pins-in-the-background] [app:first-visit-background-mismatch-blocks] pins the whole app after entering so the next visit needs no gateway, and blocks an app whose unloaded file differs from the declared tree', async () => {
  await runPhase('first-visit-background', async (check) => {
    const bad = files('Late app', 'first.visit.late')
    const gateway = await startFixtureGateway({
      good: await withDeclaredTree(files('Pinned app', 'first.visit.pinned')),
      late: await withDeclaredTree(bad, { ...bad, 'later.js': 'document.title = "what was declared"' })
    })
    let gatewayOpen = true
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const goodRoot = gateway.roots['good']!
      const lateRoot = gateway.roots['late']!
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '500' }
      })
      const running = app
      await stubNativeDialogs(running)
      await watchPages(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      // 1. An unloaded file that differs from the declared tree blocks the app, though its first page ran fine.
      const lateOrigin = `https://${lateRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${lateRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const warning = await waitSheet(running)
      check(`a security warning is shown (${warning.text.title})`, /security warning/i.test(warning.text.title))
      check(`it names the file that differs (${JSON.stringify(warning.text.files)})`, warning.text.files.includes('/later.js'))
      check('its first page was let in and parsed before the block', (await pageLog(running)).some((line) => line.startsWith('dom-ready') && line.includes(lateRoot)))
      check('nothing was pinned', !existsSync(pinPath(userData, lateOrigin)))
      check(`no grant is left (${JSON.stringify(savedGrants(userData, lateOrigin))})`, savedGrants(userData, lateOrigin).length === 0)
      await pressSheet(warning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(running), 10_000))

      // 2. Allow, then the background download pins everything, including the file the page never loads.
      const goodOrigin = `https://${goodRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${goodRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const entered = await waitForTab(chrome, { address: `ipfs://${goodRoot}/`, title: 'Pinned app' }, 60_000)
      check(`the app opened (${JSON.stringify(entered.info)})`, entered.ok)
      check('it is pinned in the background', await waitFor(() => existsSync(pinPath(userData, goodOrigin)), 60_000))
      check('the file its page never loads came down too', gateway.requests.some((request) => request.startsWith(`/ipfs/${gateway.blockOf('good', 'later.js')}`)))
      check('its grants are saved', savedGrants(userData, goodOrigin).includes('fs'))

      // 3. The gateway is gone, and the next visit is served from the pin without asking again.
      await gateway.close()
      gatewayOpen = false
      const loadsOf = async (): Promise<number> => (await pageLog(running)).filter((line) => line.startsWith('dom-ready') && line.includes(goodRoot)).length
      const before = await loadsOf()
      await clickAddressBarRetrying(chrome, `ipfs://${goodRoot}/`)
      check('the address was loaded again', await waitFor(async () => await loadsOf() > before, 30_000))
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${goodOrigin}/`); return facts?.ran === 'ran' }, 30_000)
      check(`the app runs from its pin with no gateway (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('nothing asked again', await questionGone(running))
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (gatewayOpen) await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
