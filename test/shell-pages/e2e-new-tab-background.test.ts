// The new tab's background, chosen in Settings > Appearance: the person's own picture (copied into the profile, drawn
// by every open new-tab page at once), no picture, and the Orivon one again; and a file that is not a picture.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron, mainOutput, profileDirOf } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'

const made: string[] = []
/** A folder for the pictures a spec picks, removed when the file is done. */
async function pictureDir (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orivon-newtab-bg-'))
  made.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(made.map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const dashboards = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().includes('/newtab/'))
const pictureOf = async (page: Page): Promise<string> => await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage)
const kindOf = async (page: Page): Promise<string | undefined> => await page.evaluate(() => document.documentElement.dataset['background'])

/** What the file picker answers next: a path, or null for a cancel. */
async function pickNext (app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const counted = globalThis as unknown as { __pickerOpened?: number }
    counted.__pickerOpened = 0
    dialog.showOpenDialog = (async () => {
      counted.__pickerOpened = (counted.__pickerOpened ?? 0) + 1
      return chosen === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] }
    }) as unknown as typeof dialog.showOpenDialog
  }, path)
}

/** How many times the stubbed picker has opened since it was last set. */
async function pickersOpened (app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => (globalThis as unknown as { __pickerOpened?: number }).__pickerOpened ?? 0)
}

async function openSettings (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/appearance') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('#row-new-tab-background select')
  return page
}

it('draws the person\'s own picture on every new tab, then no picture, then the Orivon one', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    const profile = profileDirOf(app) as string
    const copy = join(profile, 'new-tab-background')

    expect(await waitFor(() => dashboards(app).length === 1)).toBe(true)
    const open = dashboards(app)[0] as Page
    expect(await waitFor(async () => await kindOf(open) === 'orivon')).toBe(true)
    expect(await pictureOf(open)).toContain('intro-background')

    const picked = join(await pictureDir(), 'my picture.png')
    await writeFile(picked, PNG)
    await pickNext(app, picked)
    const settings = await openSettings(app, chrome)
    const choice = settings.locator('#row-new-tab-background select')
    expect(await settings.locator('#row-new-tab-background-choose').count()).toBe(0)
    // Your own picture comes last, so arrowing through the drop-down to No picture never opens the picker.
    expect(await choice.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(['orivon', 'none', 'custom'])

    await choice.selectOption('custom')
    // The page that was already open follows the change, with no reload.
    expect(await waitFor(async () => await kindOf(open) === 'custom')).toBe(true)
    expect(await pictureOf(open)).toContain('blob:')
    expect(readFileSync(copy)).toEqual(PNG)
    expect(await choice.inputValue()).toBe('custom')
    expect(await settings.locator('#row-new-tab-background-choose').count()).toBe(1)

    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    expect(await waitFor(() => dashboards(app).length === 2)).toBe(true)
    const fresh = dashboards(app).find((page) => page !== open) as Page
    expect(await waitFor(async () => await kindOf(fresh) === 'custom')).toBe(true)
    expect(await pictureOf(fresh)).toContain('blob:')

    await choice.selectOption('none')
    expect(await waitFor(async () => await kindOf(open) === 'none' && await kindOf(fresh) === 'none')).toBe(true)
    expect(await pictureOf(open)).toBe('none')
    expect(await waitFor(() => !existsSync(copy))).toBe(true)

    await choice.selectOption('orivon')
    expect(await waitFor(async () => await kindOf(open) === 'orivon')).toBe(true)
    expect(await pictureOf(open)).toContain('intro-background')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps what was chosen when the picker is cancelled or the file is not a picture, and says why', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    const copy = join(profileDirOf(app) as string, 'new-tab-background')
    expect(await waitFor(() => dashboards(app).length === 1)).toBe(true)
    const open = dashboards(app)[0] as Page
    const settings = await openSettings(app, chrome)
    const choice = settings.locator('#row-new-tab-background select')

    await pickNext(app, null)
    await choice.selectOption('custom')
    expect(await waitFor(async () => await choice.inputValue() === 'orivon')).toBe(true)
    // The earlier value is back without a second picker.
    expect(await pickersOpened(app)).toBe(1)

    const dir = await pictureDir()
    const notes = join(dir, 'notes.png')
    await writeFile(notes, 'This is text with a picture\'s name.')
    await pickNext(app, notes)
    await choice.selectOption('custom')
    expect(await waitFor(async () => (await settings.locator('#row-new-tab-background .problem').count()) === 1)).toBe(true)
    expect(await settings.locator('#row-new-tab-background .problem').textContent()).toContain('not a picture')
    expect(await choice.inputValue()).toBe('orivon')
    expect(existsSync(copy)).toBe(false)
    expect(await kindOf(open)).toBe('orivon')

    // A good picture afterwards clears the message.
    const good = join(dir, 'good.png')
    await writeFile(good, PNG)
    await pickNext(app, good)
    await choice.selectOption('custom')
    expect(await waitFor(async () => await kindOf(open) === 'custom')).toBe(true)
    expect(await settings.locator('#row-new-tab-background .problem').count()).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
