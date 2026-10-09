// A published app whose files differ from the hash tree its site declares is never entered: every grant the
// person gave is removed and a security warning is shown, and the next visit asks again. Files that cannot be
// downloaded (the gateway keeps answering 502) show a retry sheet instead: the grants stay, nothing is
// warned about, and Try again enters the app once the gateway recovers. Driven through the test seam's gateway.
import { afterAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { anyDocumentAt, pageAt, pinPath, pressSheet, savedGrants, sheetGone, waitSheet, withDeclaredTree } from './first-visit-support.js'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-blocks-files-that-differ-from-the-declaration] [app:first-visit-download-failure-offers-retry] blocks files that differ from the site\'s declared tree and removes every grant, and offers Try again for a download that failed while keeping them', async () => {
  await runPhase('first-visit-refusals', async (check) => {
    const mismatched = files('Mismatched app', 'first.visit.mismatched')
    const gateway = await startFixtureGateway({
      mismatched: await withDeclaredTree(mismatched, { ...mismatched, 'app.js': 'document.body.dataset.app = "something else"' }),
      flaky: await withDeclaredTree(files('Flaky app', 'first.visit.flaky'))
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const mismatchedRoot = gateway.roots['mismatched']!
      const flakyRoot = gateway.roots['flaky']!
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      // 1. Files that differ from the declaration.
      const badOrigin = `https://${mismatchedRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${mismatchedRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const warning = await waitSheet(running)
      check(`a security warning is shown (${warning.text.title})`, /security warning/i.test(warning.text.title))
      check(`it names the file that differs (${JSON.stringify(warning.text.files)})`, warning.text.files.includes('/app.js'))
      check(`it offers no way forward (${JSON.stringify(warning.text.buttons)})`, warning.text.buttons.length === 1 && warning.text.buttons[0] === 'Go back')
      check('the page was never entered', !(await anyDocumentAt(running, badOrigin)) && (await pageAt(running, `${badOrigin}/`)) === null)
      check('nothing was pinned', !existsSync(pinPath(userData, badOrigin)))
      check(`nothing was ever granted (${JSON.stringify(savedGrants(userData, badOrigin))})`, savedGrants(userData, badOrigin).length === 0)
      await pressSheet(warning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(running), 10_000))
      await delay(ABSENCE_SETTLE_MS)
      check('the page is still not entered', !(await anyDocumentAt(running, badOrigin)))
      // The block is not remembered: the next visit asks again.
      await clickAddressBarRetrying(chrome, `ipfs://${mismatchedRoot}`)
      await waitQuestion(running, 60_000)
      check('visiting it again asks again', true)
      await answerQuestion(running, 'Deny')

      // 2. A download that fails.
      const flakyOrigin = `https://${flakyRoot}.ipfs.orivon`
      gateway.failNext('flaky', 'app.js', 502, 500)
      await clickAddressBarRetrying(chrome, `ipfs://${flakyRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const retry = await waitSheet(running, 150_000)
      check(`a retry sheet names the failed download (${retry.text.title})`, /couldn't download/i.test(retry.text.title))
      check(`it offers Try again (${JSON.stringify(retry.text.buttons)})`, retry.text.buttons.includes('Try again'))
      check('it is no security warning', !/security warning/i.test(retry.text.title))
      check(`nothing is granted yet: the answer waits for the files (${JSON.stringify(savedGrants(userData, flakyOrigin))})`, savedGrants(userData, flakyOrigin).length === 0)
      check('nothing was pinned and the page was never entered', !existsSync(pinPath(userData, flakyOrigin)) && !(await anyDocumentAt(running, flakyOrigin)))
      gateway.failNext('flaky', 'app.js', 502, 0)
      await pressSheet(retry.page, 'Try again')
      const entered = await waitForTab(chrome, { address: `ipfs://${flakyRoot}/`, title: 'Flaky app' }, 90_000)
      check(`Try again entered the app (${JSON.stringify(entered.info)})`, entered.ok)
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${flakyOrigin}/`); return facts?.ran === 'ran' }, 20_000)
      check(`it runs as an app tab (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('it is pinned, and the answer given before the download is granted now', existsSync(pinPath(userData, flakyOrigin)) && savedGrants(userData, flakyOrigin).includes('fs'))
      check('Try again asked nothing again', await questionGone(running))

      expect(warning.text.title).toMatch(/security warning/i)
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
