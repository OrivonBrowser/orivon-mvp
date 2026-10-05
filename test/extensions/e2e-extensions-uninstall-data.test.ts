// What an extension keeps is removed with it: chrome.storage and the page's own localStorage are
// there before the extension is removed on orivon://extensions, gone after, and an install of the
// same extension afterwards (the same id) starts empty.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-uninstall-data.test.ts
import { afterAll, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { answeringWith, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import { FIXTURES_DIR } from '../support/extensions-fixtures.js'
import { openExtensionPage, rpc, waitRecovered } from './extensions-e2e-helpers.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000
const FIXTURE = 'api-sweep'
const NAME = 'Orivon E2E API Sweep'

async function remembered (app: ElectronApplication, id: string): Promise<{ stored: unknown, local: string | null }> {
  const wc = await openExtensionPage(app, id, 'page.html')
  const reply = await rpc(app, wc, 'chrome.storage.local.get', ['kept'])
  const local = await app.evaluate(async ({ webContents }, [contentsId]: [number]) =>
    await webContents.fromId(contentsId)?.executeJavaScript('localStorage.getItem("kept")', true) as string | null, [wc] as [number])
  return { stored: reply.ok ? reply.result : reply, local }
}

async function installFixture (app: ElectronApplication): Promise<string> {
  const outcome = await answeringWith(app, 'Add extension', app.evaluate(async (_electron, dir: string) => {
    const hook = (globalThis as unknown as { __orivonDevExtensionsInstall?: { installFromFolder: (dir: string) => Promise<{ installed: boolean, entry?: { id: string } }> } }).__orivonDevExtensionsInstall
    if (hook === undefined) throw new Error('the install test hook is not installed: build with scripts/build-e2e.mjs')
    return await hook.installFromFolder(dir)
  }, join(FIXTURES_DIR, FIXTURE)))
  expect(outcome.installed).toBe(true)
  if (outcome.entry === undefined) throw new Error('the install returned no entry')
  await waitRecovered(app)
  return outcome.entry.id
}

it('removing an extension deletes its chrome.storage and localStorage, so installing it again starts empty', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true })
  try {
    await stubNativeDialogs(app)
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const id = await installFixture(app)

    const wc = await openExtensionPage(app, id, 'page.html')
    expect(await rpc(app, wc, 'chrome.storage.local.set', [{ kept: 'yes' }])).toEqual({ ok: true, result: null })
    await app.evaluate(async ({ webContents }, [contentsId]: [number]) => {
      await webContents.fromId(contentsId)?.executeJavaScript('localStorage.setItem("kept", "yes")', true)
    }, [wc] as [number])
    expect(await remembered(app, id)).toEqual({ stored: { kept: 'yes' }, local: 'yes' })
    expect(existsSync(join(userData, 'Local Extension Settings', id))).toBe(true)

    // Removed on the extensions page, as a person does.
    const chrome = findChrome(app)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('extensions.open') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://extensions')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://extensions')) as Page
    await page.waitForSelector('.ext-list')
    const removeButton = page.locator('.ext-card', { has: page.locator('.ext-name', { hasText: NAME }) }).locator('button', { hasText: 'Remove' })
    await removeButton.click()
    await removeButton.click()
    expect(await waitFor(async () => (await page.locator('.ext-name', { hasText: NAME }).count()) === 0)).toBe(true)
    expect(await waitFor(() => !existsSync(join(userData, 'Local Extension Settings', id)))).toBe(true)
    expect(readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8')).not.toContain(id)

    // The same extension again, in the same run: the same id, and nothing of what it kept.
    expect(await installFixture(app)).toBe(id)
    expect(await remembered(app, id)).toEqual({ stored: {}, local: null })
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
