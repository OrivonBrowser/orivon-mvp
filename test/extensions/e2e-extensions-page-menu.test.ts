// What an extension adds to the right-click menu of a page: an item it created with
// chrome.contextMenus for the page context is in the menu of an ordinary tab. Native menus cannot
// be seen, so Menu.prototype.popup keeps the last menu built.
//
// Run with `npm run test:e2e`, or through scripts/run-headless.mjs with test/vitest.e2e.config.ts
// after scripts/build-e2e.mjs.
import { afterAll, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture } from '../support/e2e-helpers.js'
import { startFixtureServer } from '../support/extensions-fixtures.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type MenuHolder = { __orivonLastMenu?: { items: Array<{ label: string, type: string }> } | undefined }

async function rightClickLabels (app: ElectronApplication, page: Page): Promise<string[]> {
  await app.evaluate(() => { (globalThis as MenuHolder).__orivonLastMenu = undefined })
  await page.click('body', { button: 'right' })
  expect(await waitFor(async () => await app.evaluate(() => (globalThis as MenuHolder).__orivonLastMenu !== undefined))).toBe(true)
  return await app.evaluate(() => ((globalThis as MenuHolder).__orivonLastMenu?.items ?? []).map((item) => item.label))
}

it('shows an extension\'s contextMenus item in the right-click menu of an ordinary page', async () => {
  const started = await startFixtureServer()
  server = started.server
  let id = ''
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    seedProfile: async (dir) => { id = seedFixture(dir, 'api-sweep') },
    sandbox: true
  })
  try {
    expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)).toBe(true)
    await waitRecovered(app)
    await app.evaluate(({ Menu }) => {
      Menu.prototype.popup = function () { (globalThis as MenuHolder).__orivonLastMenu = this as never }
    })
    const wc = await openExtensionPage(app, id, 'page.html')
    const created = await rpc(app, wc, 'chrome.contextMenus.create', [{ id: 'probe', title: 'Probe item', contexts: ['page'] }])
    expect(created.ok).toBe(true)

    const view = await navigateToFixture(app, `${started.origin}/`, 'extensions-load-fixture')
    expect(await rightClickLabels(app, view)).toContain('Probe item')
  } finally {
    await closeElectronApp(app)
  }
}, 120_000)
