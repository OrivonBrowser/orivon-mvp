// A first visit caches the app beside the question, without waiting for the answer: a file the page never asks
// for is fetched before Allow, Allow reloads the tab as the app and pins what was cached, Deny stops the caching
// and pins nothing, and a file that is not the declared one, found by the caching before any answer, stops the
// page with a security warning and nothing granted. Driven through the test seam's gateway.
import { afterAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, pinPath, pressSheet, savedGrants, sheetGone, waitSheet, withDeclaredTree } from './first-visit-support.js'

/** How long caching waits before it starts: long enough for a spec to answer first, short enough not to slow the rest. */
const CACHING_STARTS_AFTER_MS = 4_000

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  // Listed by the manifest and never loaded by the first page: only caching asks for it.
  'later.js': 'document.title = "never loaded"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'later.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-caches-beside-the-question] [app:first-visit-deny-stops-caching] [app:first-visit-bad-file-found-before-allow-stops-the-page] caches a file the page never asks for before the answer, pins it on Allow after reloading as the app, stops caching on Deny, and stops the page at once for a cached file that differs from the declaration', async () => {
  await runPhase('first-visit-caching', async (check) => {
    const bad = files('Bad cache app', 'first.visit.cache.bad')
    const gateway = await startFixtureGateway({
      cached: await withDeclaredTree(files('Cached app', 'first.visit.cache.allow')),
      denied: await withDeclaredTree(files('Denied cache app', 'first.visit.cache.deny')),
      bad: await withDeclaredTree(bad, { ...bad, 'later.js': 'document.title = "what was declared"' })
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: String(CACHING_STARTS_AFTER_MS) }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      const asked = (site: string, path: string): number => gateway.requests.filter((request) => request.startsWith(`/ipfs/${gateway.blockOf(site, path)}`)).length

      // 1. Caching fetches what the page never asked for, while the question is still open.
      const cachedRoot = gateway.roots['cached']!
      const cachedOrigin = `https://${cachedRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${cachedRoot}`)
      await waitQuestion(running, 60_000)
      let website = null as PageFacts | null
      await waitFor(async () => { website = await pageAt(running, `${cachedOrigin}/`); return website?.ran === 'ran' }, 30_000)
      check(`the page is an ordinary website while the question is open (${JSON.stringify(website)})`, website?.ran === 'ran' && !website.hasProcess)
      check('a file the page never asks for is fetched before the answer', await waitFor(() => asked('cached', 'later.js') >= 1, 60_000))
      check('the question is still open, and nothing is pinned or granted', !(await questionGone(running)) && !existsSync(pinPath(userData, cachedOrigin)) && savedGrants(userData, cachedOrigin).length === 0)

      // 2. Allow: the tab reloads as the app, and what was cached is pinned.
      await answerQuestion(running, 'Allow')
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${cachedOrigin}/`); return facts?.ran === 'ran' && facts.hasProcess }, 60_000)
      check(`the tab reloaded as an app tab (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('its grants are saved', savedGrants(userData, cachedOrigin).includes('fs'))
      check('what was cached is pinned', await waitFor(() => existsSync(pinPath(userData, cachedOrigin)), 60_000))
      check(`the cached file was not fetched a second time (${String(asked('cached', 'later.js'))})`, asked('cached', 'later.js') === 1)

      // 3. Deny: caching stops before it starts, and nothing is pinned.
      const deniedRoot = gateway.roots['denied']!
      const deniedOrigin = `https://${deniedRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${deniedRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Deny')
      await delay(CACHING_STARTS_AFTER_MS + ABSENCE_SETTLE_MS)
      check('no file the page never asks for was cached after Deny', asked('denied', 'later.js') === 0)
      check('nothing is pinned or granted', !existsSync(pinPath(userData, deniedOrigin)) && savedGrants(userData, deniedOrigin).length === 0)
      const stays = await pageAt(running, `${deniedOrigin}/`)
      check(`the page stays an ordinary website (${JSON.stringify(stays)})`, stays?.ran === 'ran' && !stays.hasProcess)

      // 4. A cached file that differs stops the page before any answer.
      const badRoot = gateway.roots['bad']!
      const badOrigin = `https://${badRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${badRoot}`)
      await waitQuestion(running, 60_000)
      const warning = await waitSheet(running, 90_000)
      check(`a security warning is shown with no answer given (${warning.text.title})`, /security warning/i.test(warning.text.title))
      check(`it names the file that differs (${JSON.stringify(warning.text.files)})`, warning.text.files.includes('/later.js'))
      check('nothing is granted or pinned', savedGrants(userData, badOrigin).length === 0 && !existsSync(pinPath(userData, badOrigin)))
      check('the question went away with the page', await waitFor(async () => await questionGone(running), 10_000))
      await pressSheet(warning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(running), 10_000))
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
