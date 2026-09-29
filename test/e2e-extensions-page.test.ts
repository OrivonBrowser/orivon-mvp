// orivon://extensions end to end: opened through the `extensions.open`
// command, it lists both seeded fixtures with their name, version and
// updater sentence; toggling one off disables it in the session and the
// registry; removing the other takes it out of the page, the session and
// the registry; and Install from file, with every native dialog stubbed,
// installs a fixture .zip built on the fly.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-page.test.ts
import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp } from './e2e-helpers.js'
import { seedExtensions } from './extensions-fixtures.js'
import { parseRegistry } from '../src/main/extensions/registry.js'
import type { InstalledExtension } from '../src/main/extensions/registry.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

const extensionsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://extensions'))

async function launched (): Promise<{ app: ElectronApplication, chrome: Page, seeded: readonly InstalledExtension[] }> {
  let seeded: readonly InstalledExtension[] = []
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    seedProfile: async (dir) => { seeded = seedExtensions(dir) },
    sandbox: true
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app), seeded }
}

/** Opens the page through the same `extensions.open` command the main menu
 * and the Settings sidebar link both run -- proving the command, not only
 * the page, works. */
async function openExtensions (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => {
    (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('extensions.open')
  })
  expect(await waitFor(() => extensionsPage(app) !== undefined)).toBe(true)
  const page = extensionsPage(app) as Page
  await page.waitForSelector('.ext-list, .empty')
  return page
}

/** Replaces the native pickers: `showMessageBox` always accepts (nothing
 * here drives an install prompt), and `showOpenDialog` answers from a global
 * the test sets right before the click that opens it -- no native dialog
 * reaches the screen (this repository's hard rule for a headless run). */
async function stubDialogs (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
    dialog.showOpenDialog = (async (options: { properties?: string[] }) => {
      const wantsFolder = options.properties?.includes('openDirectory') === true
      const path = (globalThis as unknown as { __openFolderPath?: string, __openFilePath?: string })[wantsFolder ? '__openFolderPath' : '__openFilePath']
      return path === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }
    }) as unknown as typeof dialog.showOpenDialog
  })
}

async function setStubbedFile (app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_electron, filePath) => { (globalThis as unknown as { __openFilePath?: string }).__openFilePath = filePath }, path)
}

function registryOf (userData: string): readonly InstalledExtension[] {
  const parsed = parseRegistry(readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8'))
  if (parsed.corrupt) throw new Error('registry.json at userData is not the shape registry.ts writes')
  return parsed.entries
}

it('lists installed extensions with their updater sentence, toggles one off, removes another, and installs a fixture from a file', async () => {
  const { app, chrome, seeded } = await launched()
  try {
    await stubDialogs(app)
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const contentMarker = seeded.find((entry) => entry.name === 'Orivon E2E Content Marker')
    const networkPerms = seeded.find((entry) => entry.name === 'Orivon E2E Network Perms')
    if (contentMarker === undefined || networkPerms === undefined) throw new Error('the two fixtures did not seed as expected')

    const page = await openExtensions(app, chrome)
    expect(await page.title()).toBe('Extensions')
    expect(await page.evaluate(() => (window as unknown as { orivonInternal: { page: string } }).orivonInternal.page)).toBe('extensions')

    // Both fixtures are listed with their name and version; their updater
    // sentence shows once Details is opened, and is never hidden behind a
    // second toggle inside it.
    for (const entry of [contentMarker, networkPerms]) {
      if (entry.source.kind !== 'unpacked') throw new Error('the fixtures are expected to be unpacked installs')
      const sourceFolder = entry.source.from
      const card = page.locator('.ext-card', { has: page.locator('.ext-name', { hasText: entry.name }) })
      expect(await card.locator('.ext-version').textContent()).toBe(entry.version)
      await card.locator('.link-btn', { hasText: 'Details' }).click()
      const showsUpdater = await waitFor(async () =>
        (await card.locator('.ext-details').textContent() ?? '').includes(`Reload it from ${sourceFolder} to pick up changes.`))
      expect(showsUpdater).toBe(true)
    }

    // Toggling content-marker off disables it in the session and the registry.
    const contentCard = page.locator('.ext-card', { has: page.locator('.ext-name', { hasText: contentMarker.name }) })
    await contentCard.locator('.switch input').click()
    expect(await waitFor(async () =>
      await app.evaluate(({ session }, id) => session.defaultSession.extensions.getExtension(id) === null, contentMarker.id))).toBe(true)
    expect(await waitFor(() => registryOf(userData).find((entry) => entry.id === contentMarker.id)?.enabled === false)).toBe(true)

    // Removing network-perms takes it out of the page, the session and the registry.
    const networkCard = page.locator('.ext-card', { has: page.locator('.ext-name', { hasText: networkPerms.name }) })
    const removeButton = networkCard.locator('button', { hasText: 'Remove' })
    await removeButton.click()
    await removeButton.click()
    expect(await waitFor(async () => (await page.locator('.ext-name', { hasText: networkPerms.name }).count()) === 0)).toBe(true)
    expect(await waitFor(async () =>
      await app.evaluate(({ session }, id) => session.defaultSession.extensions.getExtension(id) === null, networkPerms.id))).toBe(true)
    expect(await waitFor(() => registryOf(userData).every((entry) => entry.id !== networkPerms.id))).toBe(true)

    // Install from file: a fixture .zip built on the fly, through the picker
    // stub above -- no native dialog ever appears.
    const zipDir = mkdtempSync(join(tmpdir(), 'orivon-ext-zip-'))
    try {
      const zipPath = join(zipDir, 'fixture.zip')
      const zip = new AdmZip()
      zip.addFile('manifest.json', Buffer.from(JSON.stringify({ manifest_version: 3, name: 'Orivon E2E From File', version: '1.0.0' })))
      zip.writeZip(zipPath)
      await setStubbedFile(app, zipPath)
      await page.locator('button', { hasText: 'Install from file' }).click()
      expect(await waitFor(async () => (await page.locator('.ext-name', { hasText: 'Orivon E2E From File' }).count()) === 1)).toBe(true)
    } finally {
      rmSync(zipDir, { recursive: true, force: true })
    }
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
