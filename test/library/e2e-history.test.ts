// History in the running shell: the pages a tab reaches are written down and
// listed on the History page, the new-tab and shell pages are not, a page can
// be searched for and removed, history turned off records nothing, what is
// older than the retention is gone at launch, and Clear browsing data forgets
// what it is asked to.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SqliteHistoryStore } from '../../src/main/history/sqlite-history-store.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

let server: Server
let origin = ''
const DAY = 86_400_000

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.setHeader('set-cookie', 'seen=1; Path=/')
    if (request.url === '/missing') response.statusCode = 404
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

async function launched (seed?: (dir: string) => void | Promise<void>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(seed === undefined ? {} : { seedProfile: async (dir: string) => { await seed(dir) } }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function visit (chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

async function openHistoryPage (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('history') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://history')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://history')) as Page
  await page.waitForSelector('.page')
  return page
}

const titles = async (page: Page): Promise<string[]> => await page.locator('.entry .title').allTextContents()

it('lists the pages that were visited, and only those', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, `${origin}/one`)
    await visit(chrome, `${origin}/two`)
    await visit(chrome, `${origin}/missing`)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('settings') })

    const page = await openHistoryPage(app, chrome)

    expect(await waitFor(async () => (await titles(page)).length === 2)).toBe(true)
    // Newest first, under Today; the error page, the new-tab page and Settings are not there.
    expect(await titles(page)).toEqual(['Page /two', 'Page /one'])
    expect(await page.locator('.day h2').allTextContents()).toEqual(['Today'])
    expect(await page.locator('.entry .url').first().textContent()).toBe(`${origin}/two`)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('finds a page by part of its title, removes one, and forgets everything on a second click', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, `${origin}/alpha`)
    await visit(chrome, `${origin}/beta`)
    const page = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(page)).length === 2)).toBe(true)

    await page.fill('input[type=search]', 'ALPH')
    expect(await waitFor(async () => (await titles(page)).join() === 'Page /alpha')).toBe(true)
    await page.fill('input[type=search]', 'nothing like this')
    expect(await waitFor(async () => (await page.locator('.empty').count()) === 1)).toBe(true)
    await page.fill('input[type=search]', '')
    expect(await waitFor(async () => (await titles(page)).length === 2)).toBe(true)

    await page.locator('.entry', { hasText: '/alpha' }).hover()
    await page.locator('.entry', { hasText: '/alpha' }).locator('.remove').click()
    expect(await waitFor(async () => (await titles(page)).join() === 'Page /beta')).toBe(true)
    await page.reload()
    await page.waitForSelector('.page')
    expect(await waitFor(async () => (await titles(page)).join() === 'Page /beta')).toBe(true)

    await page.locator('button', { hasText: 'Clear all history' }).click()
    expect(await titles(page)).toEqual(['Page /beta'])
    await page.locator('button', { hasText: 'Click again to clear' }).click()
    expect(await waitFor(async () => (await page.locator('.empty').count()) === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('records nothing while history is off, and says so on the page', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'history.remember': false } }))
  })
  try {
    await visit(chrome, `${origin}/private-ish`)
    const page = await openHistoryPage(app, chrome)
    expect(await page.locator('.banner').textContent()).toContain('History is off')
    await delay(700)
    expect(await titles(page)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('removes at launch what is older than the retention, and keeps what is newer', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await mkdir(dir, { recursive: true })
    const seeded = new SqliteHistoryStore(join(dir, 'history.db'))
    seeded.record('https://ancient.example/', 'Ancient page', Date.now() - 120 * DAY)
    seeded.record('https://recent.example/', 'Recent page', Date.now() - 2 * DAY)
    seeded.close()
  })
  try {
    const page = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(page)).length > 0)).toBe(true)
    expect(await titles(page)).toEqual(['Recent page'])
    expect(await page.locator('.day h2').count()).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps what was written when the browser quits', async () => {
  const { app, chrome } = await launched()
  try {
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    await visit(chrome, `${origin}/remembered`)
    const exit = new Promise<number | null>((resolve) => { app.process().once('exit', (code) => { resolve(code) }) })

    // The write is debounced; quitting must wait for it.
    await app.evaluate(({ app: electron }) => { electron.quit() }).catch(() => {})

    expect(await Promise.race([exit, delay(15_000).then(() => 'still running' as const)])).toBe(0)
    const reopened = new SqliteHistoryStore(join(userData, 'history.db'))
    expect(reopened.list().map((entry) => entry.title)).toContain('Page /remembered')
    reopened.close()
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('clears what Clear browsing data is asked to, and nothing else', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, `${origin}/cleared`)
    const cookies = async (): Promise<number> => await app.evaluate(async ({ session }) => (await session.defaultSession.cookies.get({})).length)
    expect(await waitFor(async () => await cookies() > 0)).toBe(true)

    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-clear-data')

    // Only cookies: history stays.
    const block = settings.locator('#row-clear-data')
    await block.locator('label', { hasText: 'Browsing history' }).locator('input').uncheck()
    await block.locator('label', { hasText: 'Cookies and site data' }).locator('input').check()
    await block.locator('button', { hasText: 'Clear data' }).click()
    await block.locator('button', { hasText: 'Click again to clear' }).click()
    expect(await waitFor(async () => ((await block.locator('[role=status]').textContent()) ?? '') !== '')).toBe(true)
    expect(await block.locator('[role=status]').textContent()).toBe('Cleared.')
    expect(await waitFor(async () => await cookies() === 0)).toBe(true)

    const history = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(history)).length === 1)).toBe(true)

    // Now the history, for all time.
    // The History page took the foreground; asking for Settings again brings its tab back.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
    await block.locator('label', { hasText: 'Cookies and site data' }).locator('input').uncheck()
    await block.locator('label', { hasText: 'Browsing history' }).locator('input').check()
    await block.locator('select').selectOption('all')
    await block.locator('button', { hasText: 'Clear data' }).click()
    await block.locator('button', { hasText: 'Click again to clear' }).click()
    expect(await waitFor(async () => (await block.locator('[role=status]').textContent()) === 'Cleared.')).toBe(true)
    await history.reload()
    await history.waitForSelector('.page')
    expect(await waitFor(async () => (await history.locator('.empty').count()) === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

const PAGE_SIZE = 100

it('a push keeps "Show more" expanded and the scroll position on an already-open page', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await mkdir(dir, { recursive: true })
    const seeded = new SqliteHistoryStore(join(dir, 'history.db'))
    // Recent (well inside the default 90-day retention prune runs at
    // launch), oldest first so the newest (highest number) sorts to the top
    // -- more than one page, so "Show more" has something to do.
    const now = Date.now()
    for (let i = 0; i < PAGE_SIZE + 20; i++) seeded.record(`${origin}/seed-${String(i)}`, `Seed ${String(i)}`, now - (PAGE_SIZE + 20 - i) * 1000)
    seeded.close()
  })
  try {
    const history = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(history)).length === PAGE_SIZE)).toBe(true)
    await history.click('.more button')
    expect(await waitFor(async () => (await titles(history)).length === PAGE_SIZE + 20)).toBe(true)
    await history.evaluate(() => { window.scrollTo(0, 400) })
    expect(await waitFor(async () => await history.evaluate(() => window.scrollY) === 400)).toBe(true)

    // A NEW tab: opening History made it the active one, and typing into
    // chrome's own address bar navigates whichever tab is active -- without
    // this, the visit would replace the History page itself.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    await visit(chrome, `${origin}/while-open`)

    // Catches the new page without a reopen: "Show more" is still expanded to
    // at least the SAME depth it was (reloaded a page at a time, so it lands
    // on the next PAGE_SIZE boundary at or past the old depth plus the new
    // entry -- 121 here, never silently collapsed back to one page), and the
    // scroll position survives the reload underneath it.
    //
    // BOTH AT ONCE, not two separate waits: the pre-push state already has
    // 120 entries, so a wait on length alone would resolve before the push's
    // own reload ever ran; the new entry, being newest, appears in the first
    // (100-entry) partial render the multi-page catch-up produces on its way
    // to 121, so a wait on its presence alone could resolve before that
    // reload finishes growing past 120. Only the settled state has both.
    const finalLength = PAGE_SIZE + 21
    expect(await waitFor(async () => {
      const rows = await titles(history)
      return rows.length === finalLength && rows.includes('Page /while-open')
    })).toBe(true)
    expect(await history.evaluate(() => window.scrollY)).toBe(400)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('"Show more" survives a push past 500 loaded entries -- history-store.ts\'s MAX_PAGE_SIZE', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await mkdir(dir, { recursive: true })
    const seeded = new SqliteHistoryStore(join(dir, 'history.db'))
    const now = Date.now()
    const total = 700
    for (let i = 0; i < total; i++) seeded.record(`${origin}/deep-${String(i)}`, `Deep ${String(i)}`, now - (total - i) * 1000)
    seeded.close()
  })
  try {
    const history = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(history)).length === PAGE_SIZE)).toBe(true)
    // Five clicks: 100 (already loaded) + 5*100 = 600, past history-store.ts's
    // own MAX_PAGE_SIZE (500) -- asking main for 600 in one request would be
    // clamped to 500 and read as "nothing more".
    for (let i = 0; i < 5; i++) {
      await history.click('.more button')
      const expected = PAGE_SIZE * (i + 2)
      expect(await waitFor(async () => (await titles(history)).length === expected)).toBe(true)
    }
    expect(await history.locator('.more button').isHidden()).toBe(false)

    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    await visit(chrome, `${origin}/past-500`)

    // The regression: `more` used to read false here (the reply was clamped
    // to 500, not the 600 asked for), hiding "Show more" for good.
    //
    // BOTH AT ONCE: the pre-push state already has 600 entries, so a wait on
    // length alone would resolve before the push's own reload ever ran; the
    // new entry, being newest, appears in the first (100-entry) partial
    // render the multi-page catch-up produces on its way back up to 600, so
    // a wait on its presence alone could resolve mid-catch-up. Only the
    // settled state has both.
    expect(await waitFor(async () => {
      const rows = await titles(history)
      return rows.length === 600 && rows.includes('Page /past-500')
    })).toBe(true)
    expect(await history.locator('.more button').isHidden()).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
