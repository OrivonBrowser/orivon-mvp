// The downloads button and bubble in the running shell: the button appears with the first download and its
// tooltip follows the progress; a new download opens the bubble as a peek that never takes focus; Pause,
// Resume and Cancel work from it; a finished file is opened, or shown in its folder, from it; a file of a type
// that runs code waits under a temporary name for Keep or Discard; the setting and the toolbar choice switch
// the peek and the button off; and a private window works from memory. The system's file manager is replaced,
// so nothing opens on the screen. With ORIVON_SHOTS_DIR set it also photographs every state in both themes.
import { existsSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { delay, popoverShown, waitFor } from './smoke-helpers.mjs'
import { clickLink, launchDownloads, removeDir, scratchDir, shellCalls, startServer, stubSystem, visitFiles } from './downloads-fixture.js'
import type { DownloadServer } from './downloads-fixture.js'

type App = ElectronApplication
/** The bubble ignores a click for this long after a peek appears or a file turns held; a click that follows waits it out. */
const SETTLE_MS = 650
const SHOTS = process.env['ORIVON_SHOTS_DIR']
const TEST_TIMEOUT_MS = 120_000
/** Longer than the peek's five seconds, so one wait sees it go. */
const PEEK_GONE_MS = 12_000
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

const isShown = async (app: App, name: string): Promise<boolean> => await popoverShown(app, `overlay=${name}&`)
const pageOf = (app: App, name: string): Page | undefined => app.windows().find((w) => w.url().includes(`overlay=${name}&`))

async function overlayPage (app: App, name: string): Promise<Page> {
  expect(await waitFor(async () => await isShown(app, name))).toBe(true)
  expect(await waitFor(() => pageOf(app, name) !== undefined)).toBe(true)
  const page = pageOf(app, name) as Page
  await page.waitForSelector('.dlb-head')
  return page
}

const rowOf = (page: Page, name: string) => page.locator('.dlb-row', { hasText: name })
const button = (chrome: Page) => chrome.locator('#downloads')
const titleOf = async (chrome: Page): Promise<string> => (await button(chrome).getAttribute('title')) ?? ''
const attentionOf = async (chrome: Page): Promise<string> => (await button(chrome).getAttribute('data-attention')) ?? ''

async function setScheme (app: App, pages: Page[], scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  for (const page of pages) await page.emulateMedia({ colorScheme: scheme })
  await delay(400)
}

/** The toolbar's right end and the overlay, in both themes. The pointer is parked away so no hover look is photographed. */
async function shoot (app: App, chrome: Page, name: string, overlay?: Page): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(app, overlay === undefined ? [chrome] : [chrome, overlay], scheme)
    await chrome.screenshot({ path: join(SHOTS, `${name}-toolbar-${scheme}.png`), clip: { x: 640, y: 36, width: 640, height: 44 } })
    if (overlay !== undefined) await overlay.screenshot({ path: join(SHOTS, `${name}-bubble-${scheme}.png`) })
  }
  await setScheme(app, overlay === undefined ? [chrome] : [chrome, overlay], 'light')
}

const leftIn = async (dir: string): Promise<string[]> => (await readdir(dir)).sort()
const heldName = (names: string[]): string | undefined => names.find((name) => /^Unconfirmed .+\.download$/.test(name))

it('shows the button with the first download, peeks, and pauses, resumes and cancels from the bubble', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    expect(await button(chrome).isHidden()).toBe(true)
    const files = await visitFiles(app, chrome, server.origin)
    expect(await button(chrome).isHidden()).toBe(true)

    await clickLink(files, '#slow')
    await button(chrome).waitFor({ state: 'visible' })
    expect(await waitFor(async () => /^1 download, \d+%$/.test(await titleOf(chrome)))).toBe(true)
    expect(await button(chrome).getAttribute('data-ring')).toBe('fill')

    // The peek opens by itself and lists the file; it never takes the keys.
    const peek = await overlayPage(app, 'downloads-peek')
    await rowOf(peek, 'slow.bin').waitFor()
    expect(await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')).not.toContain('/overlay/')

    await delay(SETTLE_MS)
    await rowOf(peek, 'slow.bin').locator('[data-action="pause"]').click()
    await peek.waitForSelector('.dlb-row.is-paused')
    expect(await waitFor(async () => (await titleOf(chrome)).includes('paused'))).toBe(true)
    expect(await button(chrome).getAttribute('data-paused')).toBe('true')
    expect(await rowOf(peek, 'slow.bin').locator('.dlb-line-text').textContent()).toMatch(/^Paused · /)

    await rowOf(peek, 'slow.bin').locator('[data-action="resume"]').click()
    await peek.waitForSelector('.dlb-row.is-completed', { timeout: 30_000 })
    // The pointer is still over the peek after the clicks, which keeps it open: take it away once the rows have settled.
    await delay(500)
    await peek.evaluate(() => { document.body.dispatchEvent(new PointerEvent('pointerleave')) })
    expect(await rowOf(peek, 'slow.bin').locator('.dlb-line-text').textContent()).toBe('1.3 MB · 127.0.0.1')
    expect(await waitFor(async () => (await attentionOf(chrome)) === 'done')).toBe(true)
    expect(await waitFor(async () => !(await isShown(app, 'downloads-peek')), PEEK_GONE_MS)).toBe(true)

    // The dot stays until the bubble is opened; opening it clears the dot and focuses the first row.
    await button(chrome).click()
    const bubble = await overlayPage(app, 'downloads')
    expect(await waitFor(async () => (await attentionOf(chrome)) === 'none')).toBe(true)
    expect(await bubble.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['id'] !== undefined)).toBe(true)

    // Enter on the row opens the file and closes the bubble; Show in folder shows it.
    await bubble.keyboard.press('Enter').catch(() => {})
    expect(await waitFor(async () => (await shellCalls(app)).includes(`open ${join(dir, 'slow.bin')}`))).toBe(true)
    expect(await waitFor(async () => !(await isShown(app, 'downloads')))).toBe(true)
    await button(chrome).click()
    const again = await overlayPage(app, 'downloads')
    await rowOf(again, 'slow.bin').hover()
    await rowOf(again, 'slow.bin').locator('[data-action="showInFolder"]').click()
    expect(await waitFor(async () => (await shellCalls(app)).includes(`show ${join(dir, 'slow.bin')}`))).toBe(true)

    // A second download is cancelled from the peek.
    await clickLink(files, '#slow')
    const second = await overlayPage(app, 'downloads-peek')
    await second.waitForSelector('.dlb-row.is-progressing')
    await delay(SETTLE_MS)
    await second.locator('.dlb-row.is-progressing [data-action="cancel"]').click()
    await second.waitForSelector('.dlb-row.is-cancelled')
    expect(await second.locator('.dlb-row.is-cancelled .dlb-line-text').textContent()).toBe('Cancelled')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('holds a file that runs code under a temporary name until Keep or Discard, and never opens it', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#exe')
    const peek = await overlayPage(app, 'downloads-peek')
    await peek.waitForSelector('.dlb-row.is-held')
    const names = await leftIn(dir)
    expect(heldName(names)).toBeDefined()
    expect(names).not.toContain('setup.exe')
    expect(await rowOf(peek, 'setup.exe').locator('.dlb-line-text').textContent()).toBe('This type of file can harm your computer.')
    expect(await waitFor(async () => (await attentionOf(chrome)) === 'warn')).toBe(true)

    // A held file keeps the peek open past its five seconds.
    await delay(6500)
    expect(await isShown(app, 'downloads-peek')).toBe(true)

    // The bubble puts Discard under the keys first. Keep gives the file its name and the badge.
    await button(chrome).click()
    const bubble = await overlayPage(app, 'downloads')
    await bubble.waitForSelector('.dlb-row.is-held')
    expect(await bubble.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['action'])).toBe('discard')
    await shoot(app, chrome, 'held', bubble)
    await delay(SETTLE_MS)
    await rowOf(bubble, 'setup.exe').locator('[data-action="keep"]').click()
    await bubble.waitForSelector('.dlb-row.is-completed')
    expect(await leftIn(dir)).toEqual(['setup.exe'])
    expect(await rowOf(bubble, 'setup.exe').locator('.badge').textContent()).toBe('Open it from the folder')
    await rowOf(bubble, 'setup.exe').focus()
    // The bubble closes on the press, so the press itself may never be acknowledged.
    await bubble.keyboard.press('Enter').catch(() => {})
    expect(await waitFor(async () => (await shellCalls(app)).includes(`show ${join(dir, 'setup.exe')}`))).toBe(true)
    expect((await shellCalls(app)).some((call) => call.startsWith('open '))).toBe(false)

    // A second one answered with Discard leaves neither file.
    await clickLink(files, '#exe')
    const next = await overlayPage(app, 'downloads-peek')
    await next.waitForSelector('.dlb-row.is-held')
    expect(heldName(await leftIn(dir))).toBeDefined()
    await delay(SETTLE_MS)
    await next.locator('.dlb-row.is-held [data-action="discard"]').click()
    expect(await waitFor(async () => (await leftIn(dir)).join() === 'setup.exe')).toBe(true)
    expect(await waitFor(async () => await next.locator('.dlb-row').count() === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('answers a held file on the Downloads page too', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#exe')
    await overlayPage(app, 'downloads-peek')
    await button(chrome).click()
    const bubble = await overlayPage(app, 'downloads')
    await bubble.getByRole('button', { name: 'Show all downloads' }).click()
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://downloads')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://downloads')) as Page
    await page.waitForSelector('.download.is-held')
    expect(await page.locator('.download.is-held .dl-status-text').textContent()).toBe('This type of file can harm your computer.')
    await page.locator('.download.is-held [data-action="discard"]').click()
    await page.waitForSelector('.empty-state')
    expect(await leftIn(dir)).toEqual([])
    expect(await waitFor(async () => (await attentionOf(chrome)) === 'none')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps typing where it was while a download starts, and keeps the peek away when the setting is off', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await files.click('#field')
    await files.keyboard.type('abc')
    await clickLink(files, '#slow')
    await overlayPage(app, 'downloads-peek')
    await files.keyboard.type('def')
    expect(await files.inputValue('#field')).toBe('abcdef')
    expect(await files.evaluate(() => document.activeElement?.id)).toBe('field')
    expect(await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')).not.toContain('/overlay/')
  } finally {
    await closeElectron(app)
  }

  const quiet = await launchDownloads({ folder: dir, settings: { 'downloads.showBubble': false } })
  try {
    await stubSystem(quiet.app)
    const files = await visitFiles(quiet.app, quiet.chrome, server.origin)
    await clickLink(files, '#file')
    await button(quiet.chrome).waitFor({ state: 'visible' })
    await delay(1500)
    expect(await isShown(quiet.app, 'downloads-peek')).toBe(false)
    expect(await isShown(quiet.app, 'downloads')).toBe(false)
    expect(await button(quiet.chrome).getAttribute('data-attention')).toBe('done')
    await shoot(quiet.app, quiet.chrome, 'dot')
  } finally {
    await closeElectron(quiet.app)
  }
}, TEST_TIMEOUT_MS)

it('has no button when the toolbar choice is Never, and always shows it (with an empty bubble) when it is Always', async () => {
  const dir = await folder()
  const never = await launchDownloads({ folder: dir, settings: { 'toolbar.downloads': 'never' } })
  try {
    await stubSystem(never.app)
    const files = await visitFiles(never.app, never.chrome, server.origin)
    await clickLink(files, '#file')
    await delay(1500)
    expect(await button(never.chrome).isHidden()).toBe(true)
    expect(await isShown(never.app, 'downloads-peek')).toBe(false)
  } finally {
    await closeElectron(never.app)
  }

  const always = await launchDownloads({ folder: await folder(), settings: { 'toolbar.downloads': 'always' } })
  try {
    await stubSystem(always.app)
    await button(always.chrome).waitFor({ state: 'visible' })
    expect(await titleOf(always.chrome)).toMatch(/^Downloads \(/)
    await shoot(always.app, always.chrome, 'idle')
    await button(always.chrome).click()
    const bubble = await overlayPage(always.app, 'downloads')
    expect(await bubble.locator('.empty-state').textContent()).toContain('No downloads yet.')
    await shoot(always.app, always.chrome, 'empty', bubble)
    await bubble.keyboard.press('Escape').catch(() => {})
    expect(await waitFor(async () => !(await isShown(always.app, 'downloads')))).toBe(true)
  } finally {
    await closeElectron(always.app)
  }
}, TEST_TIMEOUT_MS)

it('works in a private window from memory, and writes no list', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir, args: ['--orivon-private'] })
  let profile = ''
  try {
    // A private run moves its user-data folder to a temporary one: that is where a list would be written.
    profile = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#file')
    await button(chrome).waitFor({ state: 'visible' })
    const peek = await overlayPage(app, 'downloads-peek')
    await peek.waitForSelector('.dlb-row.is-completed')
    expect(await rowOf(peek, 'file.bin').count()).toBe(1)
    await delay(800)
    expect(existsSync(profile)).toBe(true)
    expect(existsSync(join(profile, 'downloads.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(SHOTS === undefined)('photographs the button and the bubble in each state', async () => {
  const dir = await folder()
  const { app, chrome } = await launchDownloads({ folder: dir })
  try {
    await stubSystem(app)
    const files = await visitFiles(app, chrome, server.origin)
    await clickLink(files, '#half')
    await button(chrome).waitFor({ state: 'visible' })
    expect(await waitFor(async () => (await titleOf(chrome)) === '1 download, 40%')).toBe(true)
    let overlay = await overlayPage(app, 'downloads-peek')
    await shoot(app, chrome, 'ring-40', overlay)

    await clickLink(files, '#unknown')
    expect(await waitFor(async () => (await titleOf(chrome)) === '2 downloads, 40%')).toBe(true)
    await clickLink(files, '#stall')
    await clickLink(files, '#broken')
    await clickLink(files, '#file')
    await clickLink(files, '#exe')
    await button(chrome).click()
    overlay = await overlayPage(app, 'downloads')
    await overlay.waitForSelector('.dlb-row.is-held')
    await overlay.waitForSelector('.dlb-row.is-interrupted', { timeout: 20_000 })
    await rowOf(overlay, 'stall.bin').locator('[data-action="pause"]').click()
    await overlay.waitForSelector('.dlb-row.is-paused')
    await chrome.mouse.move(10, 10)
    await shoot(app, chrome, 'mixed', overlay)
    await rowOf(overlay, 'file.bin').hover()
    await delay(200)
    if (SHOTS !== undefined) await overlay.screenshot({ path: join(SHOTS, 'mixed-hover-light.png') })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
