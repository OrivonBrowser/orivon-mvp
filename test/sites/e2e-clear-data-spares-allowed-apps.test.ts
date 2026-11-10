// "Cookies and site data" forgets what websites stored and leaves a web3 site the person allowed alone, though both live in
// the session websites run in; "App data" is what clears the allowed site's. Driven through Settings, as a person does it.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/sites/e2e-clear-data-spares-allowed-apps.test.ts
import { afterAll, expect, it } from 'vitest'
import type { Locator, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { pageAt, withDeclaredTree } from '../web3/first-visit-support.js'

type Running = Awaited<ReturnType<typeof launchElectron>>

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.cookie = "kept=app; Secure; SameSite=Lax"; document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 20 + APP_CLOSE_RACE_MS + 180_000
const OPTIONS = ['Browsing history', 'Cookies and site data', 'Cached files', 'Saved zoom levels', 'Site settings and permissions', 'App data'] as const

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The names of the cookies the shared session holds for `url`. */
async function cookieNames (app: Running, url: string): Promise<string[]> {
  return await app.evaluate(async ({ session }, address) => (await session.defaultSession.cookies.get({ url: address })).map((cookie) => cookie.name), url)
}

/** Clears exactly the options named, in Settings, and waits for the page to say it is done. */
async function clearOnly (block: Locator, chosen: readonly (typeof OPTIONS)[number][]): Promise<void> {
  for (const option of OPTIONS) {
    // By the start of the label: another option's help text may name this one.
    const box = block.locator('label', { hasText: new RegExp(`^\\s*${option}`) }).locator('input[type=checkbox]').first()
    if (chosen.includes(option)) await box.check()
    else await box.uncheck()
  }
  await block.locator('button', { hasText: 'Clear data' }).click()
  await block.locator('button', { hasText: 'Click again to clear' }).click()
  expect(await waitFor(async () => (await block.locator('[role=status]').textContent()) === 'Cleared.')).toBe(true)
}

it('clears the websites\' data without the allowed app\'s, and the allowed app\'s with App data', async () => {
  await runPhase('clear-data-spares-allowed-apps', async (check) => {
    const gateway = await startFixtureGateway({ good: await withDeclaredTree(files('Spared app', 'spared.app')) })
    let app: Running | undefined
    try {
      const root = gateway.roots['good']!
      const origin = `https://${root}.ipfs.orivon`
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' } })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host listens', listening)
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      // 1. The site is allowed and runs as the app; a website of the same session holds a cookie of its own.
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Grant all')
      const entered = await waitForTab(chrome, { address: `ipfs://${root}/`, title: 'Spared app' }, 60_000)
      check('the allowed site is entered', entered.ok)
      check('and runs as the app', await waitFor(async () => (await pageAt(running, `${origin}/`))?.hasProcess === true, 60_000))
      check('it set its cookie in the shared session', await waitFor(async () => (await cookieNames(running, `${origin}/`)).includes('kept'), 20_000))
      await running.evaluate(async ({ session }) => { await session.defaultSession.cookies.set({ url: 'https://news.example/', name: 'site', value: 'x', secure: true }) })
      check('a website holds a cookie too', (await cookieNames(running, 'https://news.example/')).includes('site'))

      // 2. Cookies and site data: the website's goes, the allowed site's stays.
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
      check('Settings opens', await waitFor(() => running.windows().some((w) => w.url().startsWith('orivon://settings'))))
      const settings = running.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
      await settings.waitForSelector('#row-clear-data')
      const block = settings.locator('#row-clear-data')
      await clearOnly(block, ['Cookies and site data'])
      check('the website\'s cookie is gone', await waitFor(async () => !(await cookieNames(running, 'https://news.example/')).includes('site'), 20_000))
      check('the allowed site\'s cookie stays', (await cookieNames(running, `${origin}/`)).includes('kept'))

      // 3. App data: the allowed site's goes.
      await clearOnly(block, ['App data'])
      check('the allowed site\'s cookie is gone with App data', await waitFor(async () => !(await cookieNames(running, `${origin}/`)).includes('kept'), 20_000))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
