// A tab's icon comes back when the tab returns to a page whose icon it has shown, after a blank page or a page that
// failed to load stood in between: the browser announces an icon only when the set of icons changes, so the strip
// must remember what each site showed. A page whose own icons all fail shows the globe, whatever the tab remembers.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { ABSENCE_SETTLE_MS, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let server: Server
let origin = ''
let defaultIconAsks = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      defaultIconAsks++
      response.statusCode = 404
      response.end()
      return
    }
    if (request.url === '/fav.png') {
      response.setHeader('content-type', 'image/png')
      response.end(PNG)
      return
    }
    response.setHeader('content-type', 'text/html')
    const icon = request.url === '/icon' ? '<link rel="icon" href="/fav.png">' : ''
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title>${icon}<p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const hasIcon = async (chrome: Page): Promise<boolean> => await chrome.evaluate(() => document.querySelector('.tab.active .fav img')?.getAttribute('src')?.startsWith('data:') === true)

/** Loads `url` in the tab showing `from`, as a page's own navigation does. */
async function navigate (app: ElectronApplication, from: string, url: string): Promise<void> {
  await app.evaluate(({ webContents }, [current, target]) => {
    const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === current)
    void wc?.loadURL(target as string).catch(() => {})
  }, [from, url] as const)
}

/** Whether the tab showing `url` has COMMITTED it and finished loading. `getURL()` already reads a browser-started
 * navigation before it commits, and a tab shows no icon while it loads, so neither the address nor a missing icon says
 * the page has been left: Back from a page not yet committed would go to the entry before the one meant. */
async function committedAt (app: ElectronApplication, url: string): Promise<boolean> {
  return await app.evaluate(({ webContents }, target) => webContents.getAllWebContents().some((wc) => {
    const history = wc.navigationHistory
    return !wc.isLoading() && history.getEntryAtIndex(history.getActiveIndex())?.url === target
  }), url)
}

async function openIconTab (app: ElectronApplication, chrome: Page): Promise<void> {
  await chrome.click('#new-tab')
  await clickAddressBarRetrying(chrome, `${origin}/icon`)
  expect((await waitForTab(chrome, { address: `${origin}/icon` })).ok).toBe(true)
  expect(await waitFor(async () => await hasIcon(chrome)), 'the page\'s own icon shows').toBe(true)
}

it('shows the icon again on returning to the page after a blank page, by address and by Back', async () => {
  const { app, chrome } = await launched()
  try {
    await openIconTab(app, chrome)

    await navigate(app, `${origin}/icon`, 'about:blank')
    expect(await waitFor(async () => await committedAt(app, 'about:blank'))).toBe(true)
    expect(await waitFor(async () => !(await hasIcon(chrome)))).toBe(true)

    await clickAddressBarRetrying(chrome, `${origin}/icon`)
    expect((await waitForTab(chrome, { address: `${origin}/icon` })).ok).toBe(true)
    expect(await waitFor(async () => await hasIcon(chrome)), 'the icon is back after a blank page, by address').toBe(true)

    await navigate(app, `${origin}/icon`, 'about:blank')
    expect(await waitFor(async () => await committedAt(app, 'about:blank'))).toBe(true)
    expect(await waitFor(async () => !(await hasIcon(chrome)))).toBe(true)
    const wentBack = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === 'about:blank' && candidate.navigationHistory.canGoBack())
      wc?.navigationHistory.goBack()
      return wc !== undefined
    })
    expect(wentBack, 'a tab at the blank page to go Back from').toBe(true)
    expect((await waitForTab(chrome, { address: `${origin}/icon` })).ok).toBe(true)
    expect(await waitFor(async () => await hasIcon(chrome)), 'the icon is back after a blank page, by Back').toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the icon again on returning to the page after one that failed to load', async () => {
  const { app, chrome } = await launched()
  try {
    await openIconTab(app, chrome)

    await navigate(app, `${origin}/icon`, 'http://does-not-exist.invalid/')
    expect(await waitFor(async () => !(await hasIcon(chrome)))).toBe(true)

    await clickAddressBarRetrying(chrome, `${origin}/icon`)
    expect((await waitForTab(chrome, { address: `${origin}/icon` })).ok).toBe(true)
    expect(await waitFor(async () => await hasIcon(chrome)), 'the icon is back after a failed load').toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the globe on a page of the site that declares no icon, whose default /favicon.ico is missing', async () => {
  const { app, chrome } = await launched()
  try {
    await openIconTab(app, chrome)
    const asksBefore = defaultIconAsks

    await clickAddressBarRetrying(chrome, `${origin}/plain`)
    expect((await waitForTab(chrome, { address: `${origin}/plain` })).ok).toBe(true)
    expect(await waitFor(() => defaultIconAsks > asksBefore), 'the page asked for its default icon').toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(await hasIcon(chrome), 'the site\'s icon is not kept for a page whose own icon is missing').toBe(false)

    await navigate(app, `${origin}/plain`, 'about:blank')
    expect(await waitFor(async () => await committedAt(app, 'about:blank'))).toBe(true)
    await clickAddressBarRetrying(chrome, `${origin}/plain`)
    expect(await waitFor(async () => await committedAt(app, `${origin}/plain`))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(await hasIcon(chrome), 'a return after a blank page brings back the globe, not the site\'s earlier icon').toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
