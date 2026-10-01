// orivon://extensions end to end: opened through the `extensions.open`
// command, it lists both seeded fixtures with their name and version, opens
// each one's details view (with its updater sentence) and comes back, shows
// the shortcuts tab; toggling one off disables it in the session and the
// registry; removing the other takes it out of the page, the session and
// the registry; and Install from file, with every native dialog stubbed,
// installs a fixture .zip built on the fly.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-page.test.ts
import { afterAll, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp } from './e2e-helpers.js'
import { seedExtensions } from './extensions-fixtures.js'
import { parseRegistry } from '../src/main/extensions/registry.js'
import type { InstalledExtension } from '../src/main/extensions/registry.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000
const SHOTS = process.env['ORIVON_SHOTS_DIR']

/** Photographs the page in both themes when a shots folder is asked for. */
async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  await page.mouse.move(2, 2)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

const extensionsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://extensions'))

async function launched (args: string[] = []): Promise<{ app: ElectronApplication, chrome: Page, seeded: readonly InstalledExtension[] }> {
  let seeded: readonly InstalledExtension[] = []
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...args],
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
  await page.waitForSelector('.ext-list, .empty-state, .banner')
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

    // Both fixtures are listed with their name and version; Details opens a
    // view of its own with the updater sentence, and the back link returns.
    await shoot(page, 'list')
    for (const entry of [contentMarker, networkPerms]) {
      if (entry.source.kind !== 'unpacked') throw new Error('the fixtures are expected to be unpacked installs')
      const sourceFolder = entry.source.from
      const card = page.locator('.ext-card', { has: page.locator('.ext-name', { hasText: entry.name }) })
      expect(await card.locator('.ext-version').textContent()).toBe(entry.version)
      await card.locator('a.link-btn', { hasText: 'Details' }).click()
      await page.waitForSelector('.d-head h1')
      expect(await page.locator('.d-head h1').textContent()).toBe(entry.name)
      expect(page.url()).toContain(`/details?id=${entry.id}`)
      expect(await page.locator('.card > h2').first().textContent()).toBe('About')
      const showsUpdater = await waitFor(async () =>
        (await page.locator('.ext-details').textContent() ?? '').includes(`Reload it from ${sourceFolder} to pick up changes.`))
      expect(showsUpdater).toBe(true)
      if (entry === contentMarker) await shoot(page, 'details')
      await page.locator('a.back').click()
      await page.waitForSelector('.ext-list')
      expect(page.url()).not.toContain('/details')
    }

    // The shortcuts tab is a place of its own; the first tab brings the list back.
    await page.locator('.tab-btn', { hasText: 'Keyboard shortcuts' }).click()
    await page.waitForSelector('.empty-state')
    expect(page.url()).toContain('/shortcuts')
    expect(await page.locator('.tab-btn[aria-selected="true"]').textContent()).toBe('Keyboard shortcuts')
    await shoot(page, 'shortcuts')
    await page.locator('.tab-btn', { hasText: 'My extensions' }).click()
    await page.waitForSelector('.ext-list')

    // A details address for an extension that is not installed says so, with a way back.
    await page.evaluate(() => { history.pushState(null, '', '/details?id=nothing'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await page.waitForSelector('.empty-state')
    expect(await page.locator('.empty-state strong').textContent()).toBe('This extension is not installed')
    await page.locator('a.back').click()
    await page.waitForSelector('.ext-list')

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
      // The installed manifest is kept beside the loaded copy; with no choice made they are the same bytes, and no prefs file exists yet.
      const installed = registryOf(userData).find((entry) => entry.name === 'Orivon E2E From File')
      if (installed === undefined) throw new Error('the installed extension is not in the registry')
      expect(readFileSync(join(dirname(installed.path), 'manifest.base.json'), 'utf8')).toBe(readFileSync(join(installed.path, 'manifest.json'), 'utf8'))
      expect(existsSync(join(userData, 'extensions', 'prefs.json'))).toBe(false)
    } finally {
      rmSync(zipDir, { recursive: true, force: true })
    }
    // Settings > Apps carries the extension rows, and a search for the words a person might use finds them.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/apps') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-apps-extensions-pin-new')
    expect(await settings.locator('.group-label').allTextContents()).toEqual(['Extensions', 'Apps'])
    expect(await settings.locator('#row-apps-extensions-pin-new input[type="checkbox"]').isChecked()).toBe(true)
    await shoot(settings, 'settings-apps')
    await settings.fill('input.search', 'addons')
    await waitFor(async () => (await settings.locator('.hit').count()) === 3)
    // The two Apps rows, and the Extensions button's row in Appearance.
    expect(await settings.locator('.hit').count()).toBe(3)
    await settings.fill('input.search', '')
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('says extensions do not run in a private window, with no install controls', async () => {
  const { app, chrome } = await launched(['--orivon-private'])
  try {
    const page = await openExtensions(app, chrome)
    expect(await page.locator('.banner.info').textContent()).toBe('Extensions do not run in private or guest windows.')
    expect(await page.locator('button', { hasText: 'Install from file' }).count()).toBe(0)
    expect(await page.locator('.ext-card').count()).toBe(0)
    await shoot(page, 'private')
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
