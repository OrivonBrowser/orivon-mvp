// Import from another browser in the running shell: the page finds the browsers of a fake home, brings a
// profile's bookmarks and history in, adds nothing twice, reads a bookmarks HTML file through a stubbed dialog,
// and says so when there is nothing to import from or the window is private. No real browser profile is ever read:
// the detector is pointed at a directory this test builds. Set ORIVON_UI_SHOTS_DIR to also write screenshots
// in both colour schemes.
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chmod, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { delay, waitFor } from './smoke-helpers.mjs'
import { openInternalPage } from './downloads-fixture.js'
import { barTitles, fakeHome, launchImport, openImportPage, removeHome, runCommand, stubFileDialog } from './import-fixture.js'

const TEST_TIMEOUT_MS = 120_000
const SHOTS = process.env['ORIVON_UI_SHOTS_DIR']
const homes: string[] = []

afterAll(async () => {
  for (const home of homes) await removeHome(home)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function home (options: { firefox?: boolean, chrome?: boolean } = {}): Promise<string> {
  const made = await fakeHome(options)
  homes.push(made)
  return made
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  // A pointer left over a row would show its hover look.
  await page.mouse.move(2, 2)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await delay(400)
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

const rows = async (page: Page): Promise<string[]> => await page.locator('.listbox-item').allInnerTexts()

/** The text of the banner once it is there. */
async function banner (page: Page, selector: string): Promise<string> {
  await page.waitForSelector(selector, { timeout: 30_000 })
  return (await page.locator(selector).innerText()).replace(/\s+/g, ' ').trim()
}

const importAnother = async (page: Page): Promise<void> => {
  await page.locator('button', { hasText: 'Import from another browser' }).click()
  await page.waitForSelector('button[data-focus="import"]')
}

it('opens from the command with the browsers found, the first chosen and the file row last, and keeps the history box off when history is off', async () => {
  const fake = await home({ firefox: true })
  const { app, chrome } = await launchImport(fake, { settings: { 'history.remember': false } })
  try {
    const page = await openImportPage(app, chrome)
    await page.waitForSelector('.listbox-item')
    const listed = await rows(page)
    expect(listed).toHaveLength(4)
    expect(listed[0]).toContain('Chrome')
    expect(listed[0]).toContain('Person 1')
    expect(listed[1]).toContain('Work')
    expect(listed[2]).toContain('Firefox')
    expect(listed[2]).toContain('default-release')
    expect(listed[3]).toContain('Bookmarks HTML file')
    expect(listed[3]).toContain('A file exported from any browser')
    expect(await page.locator('.listbox-item[aria-checked="true"]').count()).toBe(1)
    expect(await page.locator('.listbox-item').first().getAttribute('aria-checked')).toBe('true')
    expect(await page.locator('h1').innerText()).toBe('Import bookmarks and history')
    const history = page.locator('input[data-focus="history"]')
    expect(await history.isDisabled()).toBe(true)
    expect(await history.isChecked()).toBe(false)
    expect(await page.locator('.what-help').innerText()).toBe('History is turned off in Settings.')
    expect(await page.locator('input[data-focus="bookmarks"]').isChecked()).toBe(true)
    await shoot(page, 'sources-history-off')

    // Up and Down move the choice like a radio group; the file row has nothing to tick.
    await page.locator('.listbox-item').first().focus()
    await page.keyboard.press('ArrowDown')
    expect(await page.locator('.listbox-item[aria-checked="true"]').innerText()).toContain('Work')
    await page.keyboard.press('End')
    expect(await page.locator('.listbox-item[aria-checked="true"]').innerText()).toContain('Bookmarks HTML file')
    expect(await page.locator('.what-row').count()).toBe(0)
    await shoot(page, 'sources-file-row')
    await page.keyboard.press('Home')
    expect(await page.locator('.what-row').count()).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('shows placeholders while the browsers are being looked for, and the choice once they are found', async () => {
  const fake = await home()
  // A named pipe stands in for a file that is slow to read: opening it waits until something writes to it.
  const pipe = join(fake, '.config', 'google-chrome', 'Local State')
  await rm(pipe)
  execFileSync('mkfifo', [pipe])
  const { app, chrome } = await launchImport(fake)
  try {
    await runCommand(chrome, 'import.open')
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://import')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://import')) as Page
    await page.waitForSelector('.skeleton-list .skeleton')
    expect(await page.locator('.listbox-item').count()).toBe(0)
    await shoot(page, 'detecting')
    const writer = await open(pipe, 'w')
    await writer.close()
    await page.waitForSelector('.listbox-item')
    expect(await page.locator('.skeleton').count()).toBe(0)
    expect(await rows(page)).toHaveLength(3)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('imports a Chrome profile: the bar shows the bookmarks, History finds the pages, and a second import adds nothing', async () => {
  const fake = await home()
  const { app, chrome } = await launchImport(fake)
  try {
    const page = await openImportPage(app, chrome)
    await page.waitForSelector('.listbox-item')
    expect(await rows(page)).toHaveLength(3)
    await shoot(page, 'sources')
    await page.locator('button[data-focus="import"]').click()

    expect(await banner(page, '.banner.ok')).toBe('Imported 3 bookmarks and 3 pages of history from Chrome. Your bookmarks bar now shows them. 1 bookmark was skipped because its address cannot be opened in Orivon.')
    expect(await page.evaluate(() => document.activeElement?.classList.contains('banner'))).toBe(true)
    await shoot(page, 'done')
    expect(await waitFor(async () => (await barTitles(chrome)).length === 2)).toBe(true)
    expect(await barTitles(chrome)).toEqual(['Chrome bar item', 'Reading'])

    // Again: nothing new is added, and what could not be opened is still counted as skipped.
    await importAnother(page)
    await page.locator('button[data-focus="import"]').click()
    expect(await banner(page, '.banner.ok')).toBe('Everything in Chrome was already in Orivon. 3 bookmarks were already in Orivon. 1 bookmark was skipped because its address cannot be opened in Orivon.')
    await shoot(page, 'done-again')
    expect(await barTitles(chrome)).toEqual(['Chrome bar item', 'Reading'])

    const history = await openInternalPage(app, chrome, 'history')
    await history.waitForSelector('.entry')
    expect(await history.locator('.entry .title').allTextContents()).toEqual(['Imported history page', 'Second imported page', 'Third imported page'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('puts the bookmarks in a folder of their own when there are some already, and says a history it cannot read is locked', async () => {
  const fake = await home({ firefox: true })
  const { app, chrome } = await launchImport(fake)
  try {
    const page = await openImportPage(app, chrome)
    await page.waitForSelector('.listbox-item')
    // Firefox first, into the empty store; then Chrome, which now goes into a folder.
    await page.locator('.listbox-item', { hasText: 'Firefox' }).click()
    await page.locator('button[data-focus="import"]').click()
    expect(await banner(page, '.banner.ok')).toBe('Imported 1 bookmark and 1 page of history from Firefox. Your bookmarks bar now shows them.')
    await importAnother(page)
    await page.locator('.listbox-item', { hasText: 'Person 1' }).click()
    await page.locator('button[data-focus="import"]').click()
    expect(await banner(page, '.banner.ok')).toContain('Bookmarks are in the folder "Imported from Chrome" on your bookmarks bar.')
    expect(await waitFor(async () => (await barTitles(chrome)).length === 2)).toBe(true)
    expect(await barTitles(chrome)).toEqual(['Fox bookmark', 'Imported from Chrome'])
    await shoot(page, 'done-folder')

    const historyFile = join(fake, '.config', 'google-chrome', 'Default', 'History')
    await chmod(historyFile, 0)
    try {
      await importAnother(page)
      await page.locator('button[data-focus="import"]').click()
      expect(await banner(page, '.banner.error')).toBe('Orivon could not read Chrome\'s history while it is running. Close Chrome and try again.')
      await shoot(page, 'error-locked')
      await page.locator('button', { hasText: 'Try again' }).click()
      await page.waitForSelector('button[data-focus="import"]')
      expect(await page.locator('.listbox-item[aria-checked="true"]').innerText()).toContain('Person 1')
    } finally {
      await chmod(historyFile, 0o600)
    }
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('imports a bookmarks HTML file through the dialog, counts an address it cannot open as skipped, and shows the wait while the dialog is open', async () => {
  const fake = await home({ chrome: false })
  const { app, chrome } = await launchImport(fake)
  try {
    const file = join(fake, 'export.html')
    await writeFile(file, `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://html-one.test/" ADD_DATE="1600000000">HTML one &amp; co</A>
    <DT><A HREF="javascript:alert(1)">Not openable</A>
  </DL><p>
  <DT><A HREF="https://html-two.test/">HTML two</A>
</DL><p>`)
    await stubFileDialog(app, file)
    const page = await openImportPage(app, chrome)
    await page.waitForSelector('.banner.info')
    expect(await rows(page)).toHaveLength(1)
    await page.locator('button[data-focus="import"]').click()
    expect(await banner(page, '.banner.ok')).toBe('Imported 2 bookmarks from the file. Your bookmarks bar now shows them. 1 bookmark was skipped because its address cannot be opened in Orivon.')
    expect(await waitFor(async () => (await barTitles(chrome)).length === 1)).toBe(true)
    expect(await barTitles(chrome)).toEqual(['HTML one & co'])

    await stubFileDialog(app, 'never')
    await importAnother(page)
    await page.locator('button[data-focus="import"]').click()
    await page.waitForSelector('.run-text')
    expect(await page.locator('.run-text').innerText()).toBe('Importing bookmarks…')
    expect(await page.locator('button[data-focus="import"]').innerText()).toBe('Importing…')
    expect(await page.locator('button[data-focus="import"]').isDisabled()).toBe(true)
    await shoot(page, 'running')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says a file that is not a bookmarks file is not one', async () => {
  const fake = await home({ chrome: false })
  const { app, chrome } = await launchImport(fake)
  try {
    const file = join(fake, 'notes.html')
    await writeFile(file, '<html><body><p>hello</p></body></html>')
    await stubFileDialog(app, file)
    const page = await openImportPage(app, chrome)
    await page.waitForSelector('.banner.info')
    await page.locator('button[data-focus="import"]').click()
    expect(await banner(page, '.banner.error')).toBe('This file is not a bookmarks file.')
    await shoot(page, 'error-format')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says so when no other browser is found, and shows only the file row', async () => {
  const fake = await home({ chrome: false })
  const { app, chrome } = await launchImport(fake)
  try {
    const page = await openImportPage(app, chrome)
    expect(await banner(page, '.banner.info')).toBe('No other browser was found on this computer. You can still import a bookmarks file.')
    expect(await rows(page)).toHaveLength(1)
    expect(await page.locator('.listbox-item').innerText()).toContain('Bookmarks HTML file')
    expect(await page.locator('.what-row').count()).toBe(0)
    await shoot(page, 'nothing-found')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('reads nothing in a private window and shows one message', async () => {
  const fake = await home()
  const { app, chrome } = await launchImport(fake, { args: ['--orivon-private'] })
  try {
    await runCommand(chrome, 'import.open')
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://import')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://import')) as Page
    expect(await banner(page, '.empty-state')).toBe('Importing is not available in a private window.')
    expect(await page.locator('.listbox-item').count()).toBe(0)
    expect(await page.locator('button[data-focus="import"]').count()).toBe(0)
    await shoot(page, 'private')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
