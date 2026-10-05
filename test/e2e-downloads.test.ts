// Downloads in the running shell: a linked file is saved to the chosen folder without a dialog and listed on
// the Downloads page; a slow one can be paused, resumed, cancelled and asked for again; a second file of the
// same name is numbered; a type that runs code is never offered for opening; rows can be removed and the list
// cleared with the files left alone; the list survives a relaunch and is never written in a private window; and
// the folder is chosen in Settings. The system's file manager and the folder picker are replaced, so nothing
// opens on the screen.
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput, profileDirOf } from './support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, waitFor } from './support/smoke-helpers.mjs'
import { bytesOf, clickLink, FILE_SIZE, launchDownloads, openInternalPage, removeDir, row, scratchDir, shellCalls, startServer, stubSystem, visitFiles } from './downloads-fixture.js'
import type { DownloadServer } from './downloads-fixture.js'

const TEST_TIMEOUT_MS = 90_000
let server: DownloadServer
const dirs: string[] = []

beforeAll(async () => { server = await startServer() })
afterAll(async () => {
  await server.close()
  for (const dir of dirs) await removeDir(dir)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function folder (): Promise<string> {
  const dir = await scratchDir()
  dirs.push(dir)
  return dir
}

const fileIn = async (dir: string, name: string, size: number): Promise<boolean> => {
  try { return (await stat(join(dir, name))).size === size } catch { return false }
}

const statusOf = async (page: Page, name: string): Promise<string> => (await row(page, name).locator('.dl-status-text').textContent()) ?? ''

it('saves a linked file to the chosen folder without a dialog, lists it, and numbers a second one', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#file')
    expect(await waitFor(async () => await fileIn(dir, 'file.bin', FILE_SIZE))).toBe(true)
    expect((await readFile(join(dir, 'file.bin'))).equals(bytesOf(FILE_SIZE))).toBe(true)

    const page = await openInternalPage(app, chrome, 'downloads')
    await page.waitForSelector('.download.is-completed')
    expect(await row(page, 'file.bin').locator('.dl-name-link').textContent()).toBe('file.bin')
    expect(await statusOf(page, 'file.bin')).toBe('200 KB')
    expect(await row(page, 'file.bin').locator('.dl-source').textContent()).toBe('127.0.0.1')
    expect(await page.locator('.folder-line').textContent()).toBe(`Saved to ${dir}`)

    await row(page, 'file.bin').locator('.dl-name-link').click()
    await row(page, 'file.bin').locator('[data-action="showInFolder"]').click()
    expect(await waitFor(async () => (await shellCalls(app)).length === 2)).toBe(true)
    expect(await shellCalls(app)).toEqual([`open ${join(dir, 'file.bin')}`, `show ${join(dir, 'file.bin')}`])

    await clickLink(files, '#file')
    expect(await waitFor(async () => await fileIn(dir, 'file (1).bin', FILE_SIZE))).toBe(true)
    expect(await waitFor(async () => await page.locator('.download.is-completed').count() === 2)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('pauses, resumes, cancels and retries a slow download', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#slow')
    const page = await openInternalPage(app, chrome, 'downloads')
    await page.waitForSelector('.download.is-progressing')
    expect(await page.locator('.download.is-progressing .progress').isVisible()).toBe(true)

    await row(page, 'slow.bin').locator('[data-action="pause"]').click()
    await page.waitForSelector('.download.is-paused')
    const frozen = await statusOf(page, 'slow.bin')
    expect(frozen).toMatch(/^Paused · /)
    await delay(900)
    expect(await statusOf(page, 'slow.bin')).toBe(frozen)
    expect(await page.locator('.download.is-paused .progress.is-paused').count()).toBe(1)

    await row(page, 'slow.bin').locator('[data-action="resume"]').click()
    await page.waitForSelector('.download.is-completed', { timeout: 30_000 })
    expect(await fileIn(dir, 'slow.bin', 64 * 1024 * 20)).toBe(true)

    await clickLink(files, '#slow')
    await page.waitForSelector('.download.is-progressing')
    await page.locator('.download.is-progressing [data-action="cancel"]').click()
    await page.waitForSelector('.download.is-cancelled')
    expect(await page.locator('.download.is-cancelled .dl-status-text').textContent()).toBe('Cancelled')
    // The row says Cancelled as soon as the cancel is asked for; the partial file goes once the download has ended.
    await delay(ABSENCE_SETTLE_MS)
    expect(existsSync(join(dir, 'slow (1).bin'))).toBe(false)

    await page.locator('.download.is-cancelled [data-action="retry"]').click()
    await page.waitForSelector('.download.is-progressing')
    expect(await page.locator('.download').count()).toBe(2)
    await waitFor(async () => await page.locator('.download.is-completed').count() === 2, 30_000)
    expect(await page.locator('.download.is-completed').count()).toBe(2)
    expect(await fileIn(dir, 'slow (1).bin', 64 * 1024 * 20)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('never offers a type that runs code for opening, removes a row and clears the list without touching a file', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#exe')
    await clickLink(files, '#file')
    const page = await openInternalPage(app, chrome, 'downloads')
    await page.waitForSelector('.download.is-held')
    expect(existsSync(join(dir, 'setup.exe'))).toBe(false)
    await row(page, 'setup.exe').locator('[data-action="keep"]').click()
    expect(await waitFor(async () => await page.locator('.download.is-completed').count() === 2)).toBe(true)
    await clickLink(files, '#file')
    expect(await waitFor(async () => await page.locator('.download.is-completed').count() === 3)).toBe(true)
    expect(await row(page, 'setup.exe').locator('.badge.warn').textContent()).toBe('Open it from the folder')
    expect(await row(page, 'setup.exe').locator('.dl-name-link').count()).toBe(0)
    expect(await row(page, 'file.bin').locator('.dl-name-link').count()).toBe(1)

    // The arrow keys move between rows, and Delete takes the focused row off the list.
    const activeRow = async (): Promise<string> => await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.download')?.querySelector('.dl-name')?.textContent ?? '')
    const names = await page.locator('.download .dl-name').allTextContents()
    await page.locator('.download').first().focus()
    await page.keyboard.press('ArrowDown')
    expect(await activeRow()).toBe(names[1])
    await page.keyboard.press('End')
    expect(await activeRow()).toBe(names[2])
    await page.keyboard.press('Home')
    expect(await activeRow()).toBe(names[0])
    await page.keyboard.press('End')
    await page.keyboard.press('Delete')
    expect(await waitFor(async () => await page.locator('.download').count() === 2)).toBe(true)
    expect(await row(page, 'setup.exe').count()).toBe(0)
    expect(await activeRow()).toBe(names[1])
    expect(existsSync(join(dir, 'setup.exe'))).toBe(true)

    await page.locator('.download').first().locator('[data-action="remove"]').click()
    expect(await waitFor(async () => await page.locator('.download').count() === 1)).toBe(true)

    const clear = page.locator('.head-actions .btn.danger')
    await clear.click()
    expect(await clear.textContent()).toBe('Click again to clear')
    await clear.click()
    await page.waitForSelector('.empty-state')
    expect(await page.locator('.empty-state').textContent()).toContain('Files you download appear here.')
    expect(await clear.isDisabled()).toBe(true)
    expect(existsSync(join(dir, 'file.bin'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps the list across a relaunch, and marks a file that was moved away', async () => {
  const dir = await folder()
  const first = await launchDownloads({ folder: dir })
  let profile = ''
  try {
    await stubSystem(first.app)
    const files = await visitFiles(first.app, first.chrome, server.origin)
    await clickLink(files, '#file')
    expect(await waitFor(async () => await fileIn(dir, 'file.bin', FILE_SIZE))).toBe(true)
    profile = profileDirOf(first.app) ?? ''
    expect(await waitFor(() => existsSync(join(profile, 'downloads.json')))).toBe(true)
    const stored = JSON.parse(await readFile(join(profile, 'downloads.json'), 'utf8')) as { entries: Array<{ fileName: string, state: string }> }
    expect(stored.entries.map((entry) => [entry.fileName, entry.state])).toEqual([['file.bin', 'completed']])
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }
  await rm(join(dir, 'file.bin'))
  const second = await launchDownloads({ reuseProfile: profile })
  try {
    await stubSystem(second.app)
    const page = await openInternalPage(second.app, second.chrome, 'downloads')
    await page.waitForSelector('.download')
    expect(await page.locator('.download').count()).toBe(1)
    expect(await page.locator('.download.is-missing .dl-status-text').textContent()).toBe('Moved or deleted')
    expect(await page.locator('.download.is-missing .dl-name-link').count()).toBe(0)
    expect(await page.locator('.download.is-missing [data-action]').evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset['action']))).toEqual(['retry', 'remove'])
  } finally {
    await closeElectron(second.app)
  }
}, TEST_TIMEOUT_MS)

it('works in a private window, in memory only, and says so', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ args: ['--orivon-private'] })
  try {
    await stubSystem(app, dir)
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#file')
    expect(await waitFor(async () => await fileIn(dir, 'file.bin', FILE_SIZE))).toBe(true)
    const page = await openInternalPage(app, chrome, 'downloads')
    await page.waitForSelector('.download.is-completed')
    expect(await page.locator('.banner.info').textContent()).toBe('Files you download in a private window stay on this computer. This list is forgotten when the window closes.')
    await delay(1000)
    expect(existsSync(join(userData, 'downloads.json'))).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('saves to the folder chosen in Settings, and goes back to the default when asked', async () => {
  const first = await folder()
  const second = await folder()
  const system = await folder()
  const { app, chrome } = await launchDownloads({ folder: first })
  try {
    await stubSystem(app, system)
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as unknown as typeof dialog.showOpenDialog
    }, second)
    const files = await visitFiles(app, chrome, server.origin)
    const settings = await openInternalPage(app, chrome, 'settings', '/downloads')
    expect(await settings.locator('#row-downloads-folder .value').textContent()).toBe(first)
    await settings.getByRole('button', { name: 'Change…' }).click()
    expect(await waitFor(async () => (await settings.locator('#row-downloads-folder .value').textContent()) === second)).toBe(true)

    await clickLink(files, '#file')
    expect(await waitFor(async () => await fileIn(second, 'file.bin', FILE_SIZE))).toBe(true)
    expect(existsSync(join(first, 'file.bin'))).toBe(false)

    await settings.getByRole('button', { name: 'Use the default folder' }).click()
    expect(await waitFor(async () => (await settings.locator('#row-downloads-folder .value').textContent()) === system)).toBe(true)
    expect(await settings.getByRole('button', { name: 'Use the default folder' }).count()).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
