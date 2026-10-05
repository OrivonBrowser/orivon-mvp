// A process can hold several shell windows. What used to assume exactly one:
// channels registered with ipcMain.handle (a second registration throws), a
// bookmark store built per window, and popovers that removed a process-wide
// handler when they closed.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { bookmarkUrls, delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

let server: Server
let pageUrl = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>fixture</title><p>fixture</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  pageUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 45_000

function chromePages (app: ElectronApplication): Page[] {
  return app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
}

async function firstChrome (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return findChrome(app)
}

/** Opens a second window from the first one's chrome and returns the new chrome page. */
async function openSecondWindow (app: ElectronApplication, first: Page): Promise<Page> {
  await first.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
  expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
  const second = chromePages(app).find((page) => page !== first)
  if (second === undefined) throw new Error('the second window\'s chrome view did not appear')
  return second
}

it('a second window has its own tabs, and the first is unaffected', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    const first = await firstChrome(app)
    const second = await openSecondWindow(app, first)
    expect(await waitFor(async () => (await tabIds(second)).length === 1)).toBe(true)

    await second.click('#new-tab')

    expect(await waitFor(async () => (await tabIds(second)).length === 2)).toBe(true)
    expect(await tabIds(first)).toHaveLength(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('closing one window with two tabs leaves the other working, bookmarks included', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    const first = await firstChrome(app)
    const second = await openSecondWindow(app, first)
    await second.click('#new-tab')
    expect(await waitFor(async () => (await tabIds(second)).length === 2)).toBe(true)

    // Windows are numbered in the order they were made; the second is the higher.
    await app.evaluate(({ BaseWindow }) => { [...BaseWindow.getAllWindows()].sort((a, b) => b.id - a.id)[0]?.close() })
    expect(await waitFor(() => chromePages(app).length === 1)).toBe(true)

    // Starring runs the store's listeners: the closed window's must be gone.
    await clickAddressBarRetrying(first, pageUrl)
    expect((await waitForTab(first, { address: pageUrl })).ok).toBe(true)
    await first.click('#bookmark-toggle')

    expect(await waitFor(async () => (await bookmarkUrls(first)).length === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the same popover opens in two windows one after the other', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    const first = await firstChrome(app)
    const second = await openSecondWindow(app, first)
    const popovers = (): Page[] => app.windows().filter((w) => w.url().endsWith('/permissions/index.html'))

    await first.click('#permissions-btn')
    expect(await waitFor(() => popovers().length === 1)).toBe(true)
    // Opening the other window's popover blurs the first, which closes it.
    await second.click('#permissions-btn')
    expect(await waitFor(() => popovers().length === 1)).toBe(true)
    await delay(300)

    const [popover] = popovers()
    expect(popover).toBeDefined()
    expect(await waitFor(async () => await popover?.locator('#empty-state').count() === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('second handler')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
