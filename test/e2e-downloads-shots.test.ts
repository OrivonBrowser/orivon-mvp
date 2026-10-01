// Screenshots of the Downloads page in every row state, the Settings section and a private window, in both
// themes. Reads like a tour: each state is reached through the real shell, then the page is captured.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { delay, waitFor } from './smoke-helpers.mjs'
import { clickLink, launchDownloads, openInternalPage, removeDir, row, scratchDir, startServer, stubSystem, visitFiles } from './downloads-fixture.js'
import type { DownloadServer } from './downloads-fixture.js'

const SHOTS = process.env['ORIVON_SHOTS_DIR']
const TEST_TIMEOUT_MS = 120_000
let server: DownloadServer
const dirs: string[] = []

beforeAll(async () => { server = await startServer() })
afterAll(async () => {
  await server.close()
  for (const dir of dirs) await removeDir(dir)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function shoot (_app: ElectronApplication, page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await delay(500)
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  }
}

it('photographs the downloads page in each state', async () => {
  const dir = await scratchDir()
  dirs.push(dir)
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    const page = await openInternalPage(app, chrome, 'downloads')
    await shoot(app, page, 'downloads-empty')

    await clickLink(files, '#file')
    await clickLink(files, '#exe')
    await page.waitForSelector('.download.is-held')
    await shoot(app, page, 'downloads-held')
    await row(page, 'setup.exe').locator('[data-action="keep"]').click()
    await waitFor(async () => await page.locator('.download.is-completed').count() === 2)
    await clickLink(files, '#broken')
    await page.waitForSelector('.download.is-interrupted', { timeout: 20_000 })
    await clickLink(files, '#stall')
    await page.waitForSelector('.download.is-progressing')
    await page.locator('.download.is-progressing [data-action="pause"]').click()
    await page.waitForSelector('.download.is-paused')
    await clickLink(files, '#file')
    await waitFor(async () => await page.locator('.download.is-completed').count() === 3)
    await rm(join(dir, 'file.bin'))
    await clickLink(files, '#stall')
    await waitFor(async () => await page.locator('.download.is-progressing').count() === 1)
    await page.locator('.download.is-progressing [data-action="cancel"]').click()
    await page.waitForSelector('.download.is-cancelled')
    await delay(2200)
    await clickLink(files, '#slow')
    await page.reload()
    await page.waitForSelector('.download.is-progressing')
    await row(page, 'file (1).bin').first().locator('.dl-name').hover()
    await shoot(app, page, 'downloads-states')

    await row(page, 'setup.exe').locator('[data-action="deleteFile"]').click()
    await shoot(app, page, 'downloads-armed-delete')

    const small = await app.evaluate(({ BaseWindow }) => { const win = BaseWindow.getAllWindows()[0]; win?.setSize(560, 800); return win?.getSize() })
    expect(small).toBeDefined()
    await delay(600)
    await shoot(app, page, 'downloads-narrow')

    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(1280, 800) })
    await delay(600)
    const settings = await openInternalPage(app, chrome, 'settings', '/downloads')
    await shoot(app, settings, 'settings-downloads')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('photographs a private window', async () => {
  const dir = await scratchDir()
  dirs.push(dir)
  const { app, chrome } = await launchDownloads({ args: ['--orivon-private'] })
  try {
    await stubSystem(app, dir)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#file')
    const page = await openInternalPage(app, chrome, 'downloads')
    await page.waitForSelector('.download.is-completed')
    await shoot(app, page, 'downloads-private')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
