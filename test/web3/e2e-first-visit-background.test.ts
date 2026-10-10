// What follows the entry of a published app: the whole bundle is cached and pinned, after which a visit is served
// from the pin with the gateway gone; a file that turns out not to be the declared one blocks the app all the same,
// even though its first page ran fine and its data is kept; an app allowed and not yet pinned is served again after
// a restart and follows its name to a new version. Driven through the test seam's gateway.
import { afterAll, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, questionGone, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, pageLog, pageValue, partitionHolds, pinPath, pressSheet, savedGrants, sheetGone, waitSheet, watchPages, withDeclaredTree } from './first-visit-support.js'

const files = (name: string, id: string, script = 'document.body.dataset.app = "ran"'): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': script,
  'later.js': 'document.title = "never loaded"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'later.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 180_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-pins-in-the-background] pins the whole app once it is cached and allowed, so the next visit needs no gateway', async () => {
  await runPhase('first-visit-background', async (check) => {
    const gateway = await startFixtureGateway({
      good: await withDeclaredTree(files('Pinned app', 'first.visit.pinned'))
    })
    let gatewayOpen = true
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const goodRoot = gateway.roots['good']!
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

      // 1. Allow, then the background download pins everything, including the file the page never loads.
      const goodOrigin = `https://${goodRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${goodRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const entered = await waitForTab(chrome, { address: `ipfs://${goodRoot}/`, title: 'Pinned app' }, 60_000)
      check(`the app opened (${JSON.stringify(entered.info)})`, entered.ok)
      check('it is pinned in the background', await waitFor(() => existsSync(pinPath(userData, goodOrigin)), 60_000))
      check('the file its page never loads came down too', gateway.requests.some((request) => request.startsWith(`/ipfs/${gateway.blockOf('good', 'later.js')}`)))
      check('its grants are saved', savedGrants(userData, goodOrigin).includes('fs'))

      // 2. The gateway is gone, and the next visit is served from the pin without asking again.
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

it('[app:first-visit-background-mismatch-blocks] blocks an allowed app whose file differs from the declared tree when its page asks for it after it ran, taking permissions and keeping what the app stored', async () => {
  await runPhase('first-visit-late-mismatch', async (check) => {
    const bad = files('Late app', 'first.visit.late', 'localStorage.setItem("mine", "kept-by-person"); document.body.dataset.app = "ran"; setTimeout(() => { fetch("later.js").catch(() => {}) }, 500)')
    const gateway = await startFixtureGateway({
      late: await withDeclaredTree(bad, { ...bad, 'later.js': 'document.title = "what was declared"' })
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const lateRoot = gateway.roots['late']!
      // Caching is held back for the whole run, so only the check on what the app's own page loads can find the file.
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

      const lateOrigin = `https://${lateRoot}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${lateRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const warning = await waitSheet(running, 90_000)
      check(`a security warning is shown (${warning.text.title})`, /security warning/i.test(warning.text.title))
      check(`it names the file that differs (${JSON.stringify(warning.text.files)})`, warning.text.files.includes('/later.js'))
      check('nothing was pinned', !existsSync(pinPath(userData, lateOrigin)))
      check(`no grant is left (${JSON.stringify(savedGrants(userData, lateOrigin))})`, savedGrants(userData, lateOrigin).length === 0)
      check('what the person\'s app stored is still there: a block takes permissions, never data', await waitFor(async () => await partitionHolds(running, userData, lateOrigin, 'kept-by-person'), 15_000) && !(await partitionHolds(running, userData, lateOrigin, 'a-value-nobody-wrote')))
      await pressSheet(warning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(running), 10_000))

      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)

it('[app:first-visit-resumes-after-a-restart] serves an app that was allowed and not yet pinned again after a restart, every file still checked, asks nothing, and finishes its pin for the root that was allowed', async () => {
  await runPhase('first-visit-resume', async (check) => {
    const bad = files('Late app', 'first.visit.late.resume')
    const gateway = await startFixtureGateway({
      good: await withDeclaredTree(files('Resumed app', 'first.visit.resumed')),
      late: await withDeclaredTree(bad, { ...bad, 'later.js': 'document.title = "what was declared"' })
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let profile: string | undefined
    const env = (delay: string): Record<string, string> => ({ ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: delay })
    const startVerifier = async (running: Awaited<ReturnType<typeof launchElectron>>): Promise<void> => {
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
    }
    try {
      const goodRoot = gateway.roots['good']!
      const lateRoot = gateway.roots['late']!
      const goodOrigin = `https://${goodRoot}.ipfs.orivon`
      const lateOrigin = `https://${lateRoot}.ipfs.orivon`

      // 1. Both apps are allowed and neither is pinned, because the download is held back for the whole run.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env('600000') })
      const first = app
      await stubNativeDialogs(first)
      await startVerifier(first)
      profile = await first.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => first.windows().length === 2)
      const chrome = findChrome(first)
      await waitForAddressBarStable(chrome)
      for (const [root, title] of [[goodRoot, 'Resumed app'], [lateRoot, 'Late app']] as const) {
        await clickAddressBarRetrying(chrome, `ipfs://${root}`)
        await waitQuestion(first, 60_000)
        await answerQuestion(first, 'Allow')
        const opened = await waitForTab(chrome, { address: `ipfs://${root}/`, title }, 60_000)
        check(`${title} opened (${JSON.stringify(opened.info)})`, opened.ok)
        let entered = null as PageFacts | null
        await waitFor(async () => { entered = await pageAt(first, `https://${root}.ipfs.orivon/`); return entered?.ran === 'ran' && entered.hasProcess }, 60_000)
        check(`${title} reloaded as an app tab (${JSON.stringify(entered)})`, entered?.hasProcess === true)
      }
      check('neither is pinned', !existsSync(pinPath(profile, goodOrigin)) && !existsSync(pinPath(profile, lateOrigin)))
      check('both are granted', savedGrants(profile, goodOrigin).includes('fs') && savedGrants(profile, lateOrigin).includes('fs'))
      app = undefined
      await closeElectronApp(first, APP_CLOSE_RACE_MS, { keepProfile: true })

      // 2. After the restart each is served again, asking nothing; the pin resumes once the app is used.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env('500'), reuseProfile: profile })
      const second = app
      await stubNativeDialogs(second)
      await watchPages(second)
      await startVerifier(second)
      await waitFor(() => second.windows().length === 2)
      const again = findChrome(second)
      await waitForAddressBarStable(again)
      await clickAddressBarRetrying(again, `ipfs://${goodRoot}/`)
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(second, `${goodOrigin}/`); return facts?.ran === 'ran' }, 40_000)
      check(`the app runs as an app tab again, with no question (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess && await questionGone(second))
      check('its pin lands, for the root that was allowed', await waitFor(() => existsSync(pinPath(profile as string, goodOrigin)), 60_000))
      check('its grants are the ones it was allowed', savedGrants(profile, goodOrigin).includes('fs'))

      await clickAddressBarRetrying(again, `ipfs://${lateRoot}/`)
      const warning = await waitSheet(second, 60_000)
      check(`the file the first run never loaded is still checked: a security warning is shown (${warning.text.title})`, /security warning/i.test(warning.text.title) && warning.text.files.includes('/later.js'))
      check('nothing was pinned for it, and no grant is left', !existsSync(pinPath(profile, lateOrigin)) && savedGrants(profile, lateOrigin).length === 0)
      await pressSheet(warning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(second), 10_000))
      expect(await noNativeDialogs(second)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)

it('[app:first-visit-follows-a-new-version] follows an app whose name is republished while it is allowed and not yet pinned: no warning, nothing forgotten, its data kept, and the new version is what is pinned', async () => {
  await runPhase('first-visit-follows', async (check) => {
    const version = (name: string, script: string, number: string): Record<string, string> => ({
      'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
      'app.js': script,
      '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id: 'first.visit.moving', name, version: number, entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
    })
    const gateway = await startFixtureGateway({
      first: await withDeclaredTree(version('Moving app', 'localStorage.setItem("mine", "kept-by-person"); document.body.dataset.app = "v1"', '1.0.0')),
      second: await withDeclaredTree(version('Moving app', 'document.body.dataset.app = "v2"; document.body.dataset.kept = localStorage.getItem("mine") || "lost"', '1.1.0'))
    }, { ipnsKeys: ['first'] })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let profile: string | undefined
    const env = (delay: string): Record<string, string> => ({ ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: delay })
    const startVerifier = async (running: Awaited<ReturnType<typeof launchElectron>>): Promise<void> => {
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
    }
    try {
      const key = gateway.keys['first']!
      const origin = `https://${key}.ipns.orivon`

      // 1. Allowed at the first version, and not pinned.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env('600000') })
      const before = app
      await stubNativeDialogs(before)
      await startVerifier(before)
      profile = await before.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => before.windows().length === 2)
      const chrome = findChrome(before)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `ipns://${key}`)
      await waitQuestion(before, 60_000)
      await answerQuestion(before, 'Allow')
      let first = null as PageFacts | null
      await waitFor(async () => { first = await pageAt(before, `${origin}/`); return first?.ran === 'v1' && first.hasProcess }, 60_000)
      check(`the first version runs as an app tab (${JSON.stringify(first)})`, first?.ran === 'v1' && first.hasProcess)
      check('it is not pinned', !existsSync(pinPath(profile, origin)))
      app = undefined
      await closeElectronApp(before, APP_CLOSE_RACE_MS, { keepProfile: true })

      // 2. The name is republished; after the restart the new version is what the address leads to.
      await gateway.republish('first', 'second')
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env('2000'), reuseProfile: profile })
      const after = app
      await stubNativeDialogs(after)
      await watchPages(after)
      await startVerifier(after)
      await waitFor(() => after.windows().length === 2)
      const again = findChrome(after)
      await waitForAddressBarStable(again)
      await clickAddressBarRetrying(again, `ipns://${key}/`)
      let second = null as PageFacts | null
      await waitFor(async () => { second = await pageAt(after, `${origin}/`); return second?.ran === 'v2' }, 60_000)
      check(`the new version runs as an app tab (${JSON.stringify(second)})`, second?.ran === 'v2' && second.hasProcess)
      check('no warning is shown, and nothing asks', sheetGone(after) && await questionGone(after))
      check('what the app stored is still there for the new version', await pageValue(after, `${origin}/`, 'document.body.dataset.kept') === 'kept-by-person')
      check('its grants are still held', savedGrants(profile, origin).includes('fs'))
      check('the new version is what is pinned', await waitFor(() => existsSync(pinPath(profile as string, origin)), 60_000))
      const pinned = JSON.parse(readFileSync(pinPath(profile, origin), 'utf8')) as { content?: { cid?: string } }
      check(`the pin names the new root (${String(pinned.content?.cid)})`, pinned.content?.cid === gateway.roots['second'])
      expect(await noNativeDialogs(after)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)
