// An extension added from now on is not put on the toolbar unless the setting says so, and one that was on the
// toolbar before stays there: a fresh install through the install route has no toolbar icon, shows unpinned in the
// Extensions menu and answers chrome.action.getUserSettings with isOnToolbar false; pinning it from the menu puts
// its icon on the toolbar; with "Pin new extensions to the toolbar" on, the next fresh install is pinned at once.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-pin-new.test.ts
import { afterAll, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { answeringWith, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import { FIXTURES_DIR } from '../support/extensions-fixtures.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 240_000

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

/** The ids of the toolbar's own icons (<browser-action-list>'s shadow DOM). */
const toolbarIds = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelector('browser-action-list')?.shadowRoot?.querySelectorAll('.action') ?? []).map((el) => el.id))

async function launched (seed: (dir: string) => void | Promise<void>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true, seedProfile: async (dir: string) => { await seed(dir) } })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  await stubNativeDialogs(app)
  return { app, chrome: findChrome(app) }
}

/** Installs a fixture folder through the real install route, answering its question in the panel. */
async function installFolder (app: ElectronApplication, name: string): Promise<string> {
  const outcome = await answeringWith(app, 'Add extension', app.evaluate(async (_electron, dir: string) => {
    const hook = (globalThis as unknown as { __orivonDevExtensionsInstall?: { installFromFolder: (dir: string) => Promise<{ installed: boolean, entry?: { id: string } }> } }).__orivonDevExtensionsInstall
    if (hook === undefined) throw new Error('the install test hook is not installed: build with scripts/build-e2e.mjs')
    return await hook.installFromFolder(dir)
  }, join(FIXTURES_DIR, name)))
  expect(outcome.installed).toBe(true)
  if (outcome.entry === undefined) throw new Error('the install returned no entry')
  return outcome.entry.id
}

it('does not pin an extension installed from now on, pins it from the menu, and pins at once when the setting is on', async () => {
  let seededId = ''
  const first = await launched((dir) => { seededId = seedFixture(dir, 'action-popup') })
  try {
    expect(await waitFor(async () => (await toolbarIds(first.chrome)).join() === seededId)).toBe(true)

    const freshId = await installFolder(first.app, 'api-sweep')
    await waitRecovered(first.app)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await toolbarIds(first.chrome)).toEqual([seededId])

    // The menu lists both, the seeded one pinned and the new one not.
    await first.chrome.click('#extensions-menu-btn')
    expect(await waitFor(async () => await popoverShown(first.app, 'overlay=extensions-menu'))).toBe(true)
    const menu = first.app.windows().find((w) => w.url().includes('overlay=extensions-menu')) as Page
    await menu.waitForSelector('.em .em-head')
    const pinState = async (id: string): Promise<string | null> => await menu.locator(`[data-key="pin:${id}"]`).getAttribute('aria-checked', { timeout: 2_000 }).catch(() => null)
    expect(await pinState(seededId)).toBe('true')
    expect(await pinState(freshId)).toBe('false')

    const page = await openExtensionPage(first.app, freshId, 'page.html')
    expect(await rpc(first.app, page, 'chrome.action.getUserSettings')).toEqual({ ok: true, result: { isOnToolbar: false } })

    // Pinning it from the menu puts its icon on the toolbar.
    await menu.click(`[data-key="pin:${freshId}"]`)
    expect(await waitFor(async () => (await toolbarIds(first.chrome)).length === 2)).toBe(true)
    expect(await toolbarIds(first.chrome)).toContain(freshId)
    expect(await noNativeDialogs(first.app)).toEqual([])
  } finally {
    await closeElectronApp(first.app)
  }

  const second = await launched(async (dir) => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'extensions.pinInstalled': true } }))
  })
  try {
    const pinnedId = await installFolder(second.app, 'api-sweep')
    await waitRecovered(second.app)
    expect(await waitFor(async () => (await toolbarIds(second.chrome)).join() === pinnedId)).toBe(true)
    expect(await noNativeDialogs(second.app)).toEqual([])
  } finally {
    await closeElectronApp(second.app)
  }
}, TEST_TIMEOUT_MS)
