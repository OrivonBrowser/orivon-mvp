// The person's extensions act on a web3 site they allowed exactly as on any other website: after a first visit's
// Grant all reloads the tab with its grants, the one copy of each extension the browser runs still reaches the page.
// Its content script runs there, and its toolbar button opens its popup with that tab in front. Once the app is pinned
// and its gateway is gone, a reload still serves the kept copy to the shared session: the page loads, the content script
// runs again and `window.orivon` is there.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-allowed-app.test.ts
import { existsSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { seedExtensions } from '../support/extensions-fixtures.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from '../web3/first-visit-support.js'
import { pageAt, pinPath, savedGrants, withDeclaredTree } from '../web3/first-visit-support.js'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

/** The newest page at `url`: whether the content-marker extension's content script ran in it, and which session it is in. */
async function extensionFacts (app: Awaited<ReturnType<typeof launchElectron>>, url: string): Promise<{ marker: string | null, sharedSession: boolean } | null> {
  return await app.evaluate(async ({ session, webContents }, address) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    const marker = await Promise.race([
      newest.executeJavaScript('document.documentElement.dataset.orivonExtensionMarker ?? null') as Promise<string | null>,
      new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 2_500))
    ]).catch(() => null)
    return { marker, sharedSession: newest.session === session.defaultSession }
  }, url).catch(() => null)
}

/** Marks the newest page at `url`, so a later read can tell a reloaded page from this one. */
async function markPage (app: Awaited<ReturnType<typeof launchElectron>>, url: string): Promise<boolean> {
  return await app.evaluate(async ({ webContents }, address) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return false
    return await newest.executeJavaScript('window.__beforeReload = true; true').catch(() => false) as boolean
  }, url).catch(() => false)
}

interface Reloaded { readonly marked: boolean, readonly orivon: boolean, readonly ran: string | null, readonly extension: string | null }

/** What the newest page at `url` holds: the mark `markPage` left, `window.orivon`, the app's script and the extension's content script. */
async function reloadedFacts (app: Awaited<ReturnType<typeof launchElectron>>, url: string): Promise<Reloaded | null> {
  return await app.evaluate(async ({ webContents }, address) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    return await Promise.race([
      newest.executeJavaScript('({ marked: window.__beforeReload === true, orivon: typeof window.orivon === "object" && window.orivon !== null, ran: document.body?.dataset.app ?? null, extension: document.documentElement.dataset.orivonExtensionMarker ?? null })') as Promise<Reloaded>,
      new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 2_500))
    ]).catch(() => null)
  }, url).catch(() => null)
}

function findPopup (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`))
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + 180_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:extensions-reach-an-allowed-site] runs the extensions\' content scripts on a site after Grant all, and opens an extension\'s popup from the toolbar with that tab in front', async () => {
  await runPhase('extensions on an allowed site', async (check) => {
    const gateway = await startFixtureGateway({ allowed: await withDeclaredTree(files('Allowed site', 'extensions.allowed.site')) })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let gatewayOpen = true
    let popupId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        sandbox: true,
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '500' },
        seedProfile: async (dir) => {
          const seeded = seedExtensions(dir, ['content-marker', 'action-popup'])
          popupId = seeded.find((entry) => entry.name === 'Orivon E2E Action Popup')?.id ?? ''
        }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const loaded = await waitFor(async () => (await running.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 2)
      check('both fixture extensions are loaded', loaded)
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length >= 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      const root = gateway.roots['allowed']!
      const origin = `https://${root}.ipfs.orivon`
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Grant all')
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${origin}/`); return facts?.ran === 'ran' && facts.hasProcess }, 60_000)
      check(`the tab reloaded with its grants (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('its grants are saved', savedGrants(userData, origin).includes('fs'))

      let reached = null as Awaited<ReturnType<typeof extensionFacts>>
      const ran = await waitFor(async () => { reached = await extensionFacts(running, `${origin}/`); return reached?.marker === 'ran' }, 20_000)
      check(`the content script ran on the allowed site, in the session extensions run in (${JSON.stringify(reached)})`, ran && reached?.sharedSession === true)

      await chrome.click(`#${popupId}`)
      const opened = await waitFor(() => findPopup(running.windows(), popupId) !== undefined, 10_000)
      check('the toolbar button opens the extension\'s popup with the allowed site in front', opened)

      // The kept copy answers the shared session: the pin lands, the gateway goes, and a reload loads the page from the copy.
      check('the app is pinned', await waitFor(() => existsSync(pinPath(userData, origin)), 60_000))
      await gateway.close()
      gatewayOpen = false
      check('the page to reload is marked', await markPage(running, `${origin}/`))
      const [tab] = await tabIds(chrome) as string[]
      await chrome.evaluate((id: string) => { (window as unknown as { orivonShell: { reload: (tab: string) => void } }).orivonShell.reload(id) }, tab as string)
      let again = null as Reloaded | null
      const loadedAgain = await waitFor(async () => { again = await reloadedFacts(running, `${origin}/`); return again !== null && !again.marked && again.ran === 'ran' && again.extension === 'ran' }, 60_000)
      check(`with the gateway gone, a reload loads the kept copy, runs the extension's content script and shows window.orivon (${JSON.stringify(again)})`, loadedAgain && again?.orivon === true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (gatewayOpen) await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
