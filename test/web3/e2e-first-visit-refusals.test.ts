// A published app is checked as it loads: a file that is not the one its site declared is never delivered to the
// page, the tab shows a security warning, and the origin holds no grant afterwards; a bad first document never
// shows at all, and the next visit asks again. A tree that cannot be read shows a retry sheet instead, the
// answer is kept, and Try again enters the app once the gateway recovers. Driven through the test seam's gateway.
import { afterAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, pageLog, pinPath, pressSheet, savedGrants, sheetGone, waitSheet, watchPages, withDeclaredTree } from './first-visit-support.js'

const files = (name: string, id: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } }),
  ...extra
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-blocks-a-file-that-differs-from-the-declaration] [app:first-visit-bad-first-document-never-shows] [app:first-visit-unreadable-declaration-offers-retry] never delivers a file that differs from the site\'s declared tree, removes every grant and warns, never shows a bad first document, and offers Try again for a tree that could not be read', async () => {
  await runPhase('first-visit-refusals', async (check) => {
    const script = files('Script app', 'first.visit.script', { 'app.js': 'console.log("BAD-SCRIPT-RAN"); document.body.dataset.app = "ran"' })
    const html = files('Html app', 'first.visit.html')
    const gateway = await startFixtureGateway({
      script: await withDeclaredTree(script, { ...script, 'app.js': 'document.body.dataset.app = "ran"' }),
      html: await withDeclaredTree(html, { ...html, 'index.html': '<!doctype html><title>what was declared</title>' }),
      flaky: await withDeclaredTree(files('Flaky app', 'first.visit.flaky'))
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const scriptRoot = gateway.roots['script']!
      const htmlRoot = gateway.roots['html']!
      const flakyRoot = gateway.roots['flaky']!
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' }
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

      // 1. A file that differs from the declared tree is never delivered to the page.
      const scriptOrigin = `https://${scriptRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${scriptRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const warning = await waitSheet(running)
      check(`a security warning is shown (${warning.text.title})`, /security warning/i.test(warning.text.title))
      check(`it names the file that differs (${JSON.stringify(warning.text.files)})`, warning.text.files.includes('/app.js'))
      check(`it offers no way forward (${JSON.stringify(warning.text.buttons)})`, warning.text.buttons.length === 1 && warning.text.buttons[0] === 'Go back')
      const log = await pageLog(running)
      check('the bad script never ran', !log.some((line) => line.includes('BAD-SCRIPT-RAN')))
      check(`nothing was pinned (${scriptOrigin})`, !existsSync(pinPath(userData, scriptOrigin)))
      check(`no grant is left (${JSON.stringify(savedGrants(userData, scriptOrigin))})`, savedGrants(userData, scriptOrigin).length === 0)
      await pressSheet(warning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(running), 10_000))
      await delay(ABSENCE_SETTLE_MS)
      check('the bad script still never ran', !(await pageLog(running)).some((line) => line.includes('BAD-SCRIPT-RAN')))
      // The block is not remembered: the next visit asks again.
      await clickAddressBarRetrying(chrome, `ipfs://${scriptRoot}`)
      await waitQuestion(running, 60_000)
      check('visiting it again asks again', true)
      await answerQuestion(running, 'Deny')

      // 2. A first document that differs never shows.
      const htmlOrigin = `https://${htmlRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${htmlRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const badHtml = await waitSheet(running)
      check(`a security warning is shown for the first document (${badHtml.text.title})`, /security warning/i.test(badHtml.text.title))
      check(`it names the document (${JSON.stringify(badHtml.text.files)})`, badHtml.text.files.includes('/index.html'))
      check('no page of the app was ever parsed', !(await pageLog(running)).some((line) => line.startsWith('dom-ready') && line.includes(htmlRoot)))
      check('no grant is left', savedGrants(userData, htmlOrigin).length === 0)
      await pressSheet(badHtml.page, 'Go back')
      check('Go back takes that sheet away', await waitFor(() => sheetGone(running), 10_000))

      // 3. A tree that cannot be read.
      const flakyOrigin = `https://${flakyRoot}.ipfs.orivon`
      gateway.failNext('flaky', '.well-known/orivon-ddoc.json', 502, 500)
      await clickAddressBarRetrying(chrome, `ipfs://${flakyRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const retry = await waitSheet(running, 150_000)
      check(`a retry sheet names what could not be read (${retry.text.title})`, /couldn't check/i.test(retry.text.title))
      check(`it offers Try again (${JSON.stringify(retry.text.buttons)})`, retry.text.buttons.includes('Try again'))
      check('it is no security warning', !/security warning/i.test(retry.text.title))
      check('nothing is granted yet: the answer waits for the tree', savedGrants(userData, flakyOrigin).length === 0)
      check('the page was never entered', !(await pageLog(running)).some((line) => line.startsWith('dom-ready') && line.includes(flakyRoot)))
      gateway.failNext('flaky', '.well-known/orivon-ddoc.json', 502, 0)
      await pressSheet(retry.page, 'Try again')
      const entered = await waitForTab(chrome, { address: `ipfs://${flakyRoot}/`, title: 'Flaky app' }, 90_000)
      check(`Try again entered the app (${JSON.stringify(entered.info)})`, entered.ok)
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${flakyOrigin}/`); return facts?.ran === 'ran' }, 20_000)
      check(`it runs as an app tab (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('the answer given before the tree was read is granted now', savedGrants(userData, flakyOrigin).includes('fs'))
      check('Try again asked nothing again', await questionGone(running))

      expect(warning.text.title).toMatch(/security warning/i)
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
