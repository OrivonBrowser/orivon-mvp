// The shell's own pages. What they do for a person (open, change a setting,
// search, reset), and what must stay true about them: only the shell opens
// one, one tab per page, a website cannot load or reach one, and a page cannot
// take a website into its own session.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

let server: Server
let siteUrl = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>a site</title><p>a site</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  siteUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

const internalPages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().startsWith('orivon://'))
const settingsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://settings'))

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function openSettings (app: ElectronApplication, chrome: Page, path?: string): Promise<Page> {
  await chrome.evaluate((p) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', p) }, path)
  expect(await waitFor(() => settingsPage(app) !== undefined)).toBe(true)
  const page = settingsPage(app) as Page
  await page.waitForSelector('.layout')
  return page
}

it('opens Settings at its first section, applies a change at once and keeps it, searches, and resets', async () => {
  const { app, chrome } = await launched()
  try {
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    const page = await openSettings(app, chrome)

    expect(await page.title()).toBe('Settings')
    expect(await page.evaluate(() => (window as unknown as { orivonInternal: { page: string } }).orivonInternal.page)).toBe('settings')
    expect((await waitForTab(chrome, { address: 'orivon://settings/appearance', title: 'Settings' })).ok).toBe(true)
    expect(await page.locator('.nav-item').allTextContents()).toEqual(['Appearance', 'Search', 'Tabs and windows', 'Keyboard shortcuts', 'Developer', 'About'])

    // A change takes effect in the browser at once, and is written to disk.
    await page.locator('select').first().selectOption('dark')
    expect(await waitFor(async () => await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'dark')).toBe(true)
    expect(await waitFor(async () => {
      try { return (JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as { values: Record<string, string> }).values['appearance.theme'] === 'dark' } catch { return false }
    })).toBe(true)
    expect(await page.locator('.changed').count()).toBe(1)

    // Search finds a setting by a word from its help, and opens it in place.
    await page.fill('input[type=search]', 'engine')
    await page.locator('.hit').first().click()
    expect((await waitForTab(chrome, { address: 'orivon://settings/search' })).ok).toBe(true)
    await page.waitForSelector('#row-search-engine')

    // Reset puts the default back, in the browser as well as on the page.
    await page.locator('.nav-item', { hasText: 'Appearance' }).click()
    await page.locator('.link-btn', { hasText: 'Reset' }).click()
    expect(await waitFor(async () => await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === 'system')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps one tab per page, and opens the page for an address typed in the address bar', async () => {
  const { app, chrome } = await launched()
  try {
    await openSettings(app, chrome)
    const afterFirst = (await tabIds(chrome)).length
    await openSettings(app, chrome)
    expect(await tabIds(chrome)).toHaveLength(afterFirst)

    await clickAddressBarRetrying(chrome, 'orivon://settings/tabs')

    expect((await waitForTab(chrome, { address: 'orivon://settings/tabs' })).ok).toBe(true)
    expect(await tabIds(chrome)).toHaveLength(afterFirst)
    expect(internalPages(app)).toHaveLength(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('sends an unknown place to the first section, and a tab that goes to a website leaves the internal session', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openSettings(app, chrome, '/no-such-section')
    expect((await waitForTab(chrome, { address: 'orivon://settings/appearance' })).ok).toBe(true)
    expect(await page.locator('.nav-item.current').textContent()).toBe('Appearance')

    await clickAddressBarRetrying(chrome, siteUrl)

    expect((await waitForTab(chrome, { address: siteUrl })).ok).toBe(true)
    expect(await waitFor(() => internalPages(app).length === 0)).toBe(true)
    const site = app.windows().find((w) => w.url() === siteUrl) as Page
    expect(await site.evaluate(() => typeof (window as unknown as { orivonInternal?: unknown }).orivonInternal)).toBe('undefined')
    // The page is gone, so asking for it again builds a fresh one.
    await openSettings(app, chrome)
    expect(internalPages(app)).toHaveLength(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('cannot be loaded, framed, fetched or opened by a website', async () => {
  const { app, chrome } = await launched()
  try {
    await clickAddressBarRetrying(chrome, siteUrl)
    expect((await waitForTab(chrome, { address: siteUrl })).ok).toBe(true)
    const site = app.windows().find((w) => w.url() === siteUrl) as Page
    const tabsBefore = (await tabIds(chrome)).length

    expect(await site.evaluate(() => typeof (window as unknown as { orivonInternal?: unknown }).orivonInternal)).toBe('undefined')
    expect(await site.evaluate(async () => await fetch('orivon://settings/').then(() => 'loaded', () => 'blocked'))).toBe('blocked')
    await site.evaluate(() => {
      const frame = document.createElement('iframe')
      frame.src = 'orivon://settings/'
      document.body.append(frame)
      window.open('orivon://settings/')
    })
    await delay(1000)

    expect(site.frames().map((frame) => frame.url()).filter((url) => url.startsWith('orivon://'))).toEqual([])
    expect(internalPages(app)).toEqual([])
    // A bad address in window.open() lands on a blank page, as it always has;
    // it is an ordinary tab, not the page asked for.
    expect((await tabIds(chrome)).length).toBeLessThanOrEqual(tabsBefore + 1)
    expect(app.windows().filter((w) => w !== chrome && w !== site).map((w) => w.url())).toSatisfy((urls: string[]) => urls.every((url) => url === 'about:blank' || url.includes('/newtab/')))
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('stays on its own page: a link or a popup to a website opens an ordinary tab, and the page refuses what it should not do', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openSettings(app, chrome)
    const tabsBefore = (await tabIds(chrome)).length

    await page.evaluate((url) => { window.open(url) }, siteUrl)
    expect(await waitFor(async () => (await tabIds(chrome)).length === tabsBefore + 1)).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url() === siteUrl))).toBe(true)
    const opened = app.windows().find((w) => w.url() === siteUrl) as Page
    expect(await opened.evaluate(() => typeof (window as unknown as { orivonInternal?: unknown }).orivonInternal)).toBe('undefined')

    // A navigation away from the page is turned into an ordinary tab too.
    await page.evaluate((url) => { location.href = url }, siteUrl)
    await delay(1000)
    expect(page.url().startsWith('orivon://settings')).toBe(true)

    // main answers only what the page is allowed to ask.
    const asked = await page.evaluate(async () => {
      const bridge = (window as unknown as { orivonInternal: { request: (domain: string, command: unknown) => Promise<unknown> } }).orivonInternal
      return {
        unknownDomain: await bridge.request('nope', {}),
        historyDomain: await bridge.request('history', { type: 'list' }),
        badValue: await bridge.request('settings', { type: 'set', key: 'appearance.theme', value: 'purple' }),
        badKey: await bridge.request('settings', { type: 'set', key: '__proto__', value: 'x' })
      }
    })
    expect(asked).toEqual({
      unknownDomain: undefined,
      historyDomain: undefined,
      badValue: { ok: false, reason: 'invalid-value' },
      badKey: { ok: false, reason: 'unknown-key' }
    })
    expect(await evaluateRetrying(chrome, () => document.title)).toBeDefined()
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
