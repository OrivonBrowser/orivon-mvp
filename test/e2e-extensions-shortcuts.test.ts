// Extension shortcuts end to end: a manifest's suggested keys are bound when
// free and reach the extension through the shortcut dispatcher, `_execute_action`
// opens the popup, Orivon's own keys always win, and orivon://extensions/shortcuts
// lists, records, moves and clears them with the choice kept across a relaunch.
//
// Fixtures: test/apps/extensions/commands/ (`_execute_action` Ctrl+Shift+Y with a
// popup, `mark` Alt+Shift+K logging to chrome.storage.session, `clash` Ctrl+T) and
// commands-other/ (`toggle` also suggesting Alt+Shift+K, `quiet` with no key).
// With ORIVON_SHOTS_DIR set the page is photographed in both themes.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-shortcuts.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from './launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from './smoke-helpers.mjs'
import { navigateToFixture, pressKey } from './e2e-helpers.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 180_000
const SHOTS = process.env['ORIVON_SHOTS_DIR']
const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function fixtureServer (): Promise<string> {
  const created = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>commands-fixture</title><body>commands</body>')
  })
  servers.push(created)
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}/`
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  await page.mouse.move(2, 2)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(350)
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

interface Ids { first: string, other: string }

async function launched (options: { reuse?: string, seed?: boolean } = {}): Promise<{ app: ElectronApplication, ids: Ids }> {
  const ids: Ids = { first: '', other: '' }
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    ...(options.reuse === undefined ? {} : { reuseProfile: options.reuse }),
    seedProfile: async (dir) => {
      if (options.seed === false || options.reuse !== undefined) return
      ids.first = seedFixture(dir, 'commands')
      ids.other = seedFixture(dir, 'commands-other')
    },
    sandbox: true
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, ids }
}

/** The ids of an already seeded profile: read back from the session, since a reused profile seeds nothing. */
async function idsOf (app: ElectronApplication): Promise<Ids> {
  const found = await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().map((extension) => ({ id: extension.id, name: extension.name })))
  return { first: found.find((entry) => entry.name === 'Orivon E2E Commands')?.id ?? '', other: found.find((entry) => entry.name === 'Orivon E2E Other Commands')?.id ?? '' }
}

interface CommandLog { name: string, tabId: number | null, hasUrl: boolean }

async function commandLog (app: ElectronApplication, wc: number): Promise<CommandLog[]> {
  const reply = await rpc(app, wc, 'chrome.storage.session.get', ['log'])
  return reply.ok ? ((reply.result as { log?: CommandLog[] }).log ?? []) : []
}

async function shortcutOf (app: ElectronApplication, wc: number, name: string): Promise<string | undefined> {
  const reply = await rpc(app, wc, 'chrome.commands.getAll')
  if (!reply.ok) return undefined
  return (reply.result as Array<{ name: string, shortcut: string }>).find((command) => command.name === name)?.shortcut
}

/** Stops every service worker without reloading any extension (Electron has no per-scope stop): the next event must start one. */
async function stopWorkers (app: ElectronApplication, wc: number): Promise<void> {
  await app.evaluate(async ({ webContents }, id: number) => {
    const target = webContents.fromId(id)
    if (target === undefined || target === null) return
    target.debugger.attach('1.3')
    try {
      await target.debugger.sendCommand('ServiceWorker.enable')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await target.debugger.sendCommand('ServiceWorker.stopAllWorkers')
    } finally {
      target.debugger.detach()
    }
  }, wc)
}

const extensionsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://extensions'))

async function openShortcutsPage (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('extensions.open') })
  expect(await waitFor(() => extensionsPage(app) !== undefined)).toBe(true)
  const page = extensionsPage(app) as Page
  await page.locator('.tab-btn', { hasText: 'Keyboard shortcuts' }).click()
  await page.waitForSelector('.sc-card, .empty-state')
  return page
}

const rowFor = (page: Page, text: string): ReturnType<Page['locator']> => page.locator('.sc-row', { hasText: text })
const capsOf = async (row: ReturnType<Page['locator']>): Promise<string[]> => await row.locator('.sc-control kbd').allTextContents()

async function record (app: ElectronApplication, page: Page, text: string, key: string, modifiers: string[]): Promise<void> {
  await rowFor(page, text).locator('.sc-change').click()
  await page.waitForSelector('.sc-field')
  await pressKey(app, 'orivon://extensions', key, modifiers)
}

it('binds suggested keys, runs them through the dispatcher, and lets the shortcuts page change, move and clear them', async () => {
  const fixtureUrl = await fixtureServer()
  const first = await launched()
  let { app } = first
  let ids = first.ids
  let dir = ''
  try {
    expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 2)).toBe(true)
    await waitRecovered(app)
    const chrome = findChrome(app)
    const rpcWc = await openExtensionPage(app, ids.first, 'rpc.html')

    // getAll reports what is bound: the free suggestions, and nothing where Orivon holds the key.
    expect(await shortcutOf(app, rpcWc, 'mark')).toBe('Alt+Shift+K')
    expect(await shortcutOf(app, rpcWc, '_execute_action')).toBe('Ctrl+Shift+Y')
    expect(await shortcutOf(app, rpcWc, 'clash')).toBe('')

    // A named command reaches the worker with the active tab; Orivon's key is still Orivon's.
    await navigateToFixture(app, fixtureUrl, 'commands-fixture')
    const tabWc = await app.evaluate(({ webContents }, url: string) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.id ?? -1, fixtureUrl)
    await pressKey(app, fixtureUrl, 'K', ['alt', 'shift'])
    expect(await waitFor(async () => (await commandLog(app, rpcWc)).length === 1)).toBe(true)
    expect((await commandLog(app, rpcWc))[0]).toEqual({ name: 'mark', tabId: tabWc, hasUrl: false })

    // _execute_action opens the popup.
    await pressKey(app, fixtureUrl, 'Y', ['control', 'shift'])
    const popupOpen = (): Page | undefined => app.windows().find((w) => w.url().startsWith(`chrome-extension://${ids.first}/popup.html`))
    expect(await waitFor(() => popupOpen() !== undefined)).toBe(true)
    // Keys work while the popup holds the focus too.
    await pressKey(app, `chrome-extension://${ids.first}/popup.html`, 'K', ['alt', 'shift'])
    expect(await waitFor(async () => (await commandLog(app, rpcWc)).length === 2)).toBe(true)
    await popupOpen()?.close()

    // Orivon's key is still Orivon's: the extension that suggested it never hears of it.
    const before = (await tabIds(chrome)).length
    await pressKey(app, fixtureUrl, 'T', ['control'])
    expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
    expect((await commandLog(app, rpcWc)).length).toBe(2)

    // The page lists both extensions, and says what could not be bound.
    const page = await openShortcutsPage(app, chrome)
    expect(await page.locator('.sc-card').count()).toBe(2)
    expect(await page.locator('.sc-card').first().locator('.sc-row').count()).toBe(3)
    expect(await capsOf(rowFor(page, 'Mark the current tab'))).toEqual(['Alt', 'Shift', 'K'])
    expect(await rowFor(page, 'Take the new-tab key').locator('.muted').allTextContents()).toEqual(['Suggested: Ctrl+T (already in use)', 'Not set'])
    expect(await rowFor(page, 'Toggle the sidebar').locator('.sc-hint').textContent()).toBe('Suggested: Alt+Shift+K (already in use)')
    await shoot(page, 'list')

    // Recording: the field waits, the next chord is the answer, it is stored and survives a relaunch.
    await rowFor(page, 'Mark the current tab').locator('.sc-change').click()
    await page.waitForSelector('.sc-field')
    await shoot(page, 'recording')
    await pressKey(app, 'orivon://extensions', 'U', ['control', 'shift'])
    expect(await waitFor(async () => (await capsOf(rowFor(page, 'Mark the current tab'))).join('+') === 'Ctrl+Shift+U')).toBe(true)
    expect(await shortcutOf(app, rpcWc, 'mark')).toBe('Ctrl+Shift+U')
    // The extension hears of the change.
    const heard = async (): Promise<unknown[]> => {
      const reply = await rpc(app, rpcWc, 'chrome.storage.session.get', ['changes'])
      return reply.ok ? ((reply.result as { changes?: unknown[] }).changes ?? []) : []
    }
    expect(await waitFor(async () => (await heard()).length === 1)).toBe(true)
    expect((await heard())[0]).toEqual({ name: 'mark', oldShortcut: 'Alt+Shift+K', newShortcut: 'Ctrl+Shift+U' })
    dir = profileDirOf(app) ?? ''
    const prefsFile = join(dir, 'extensions', 'prefs.json')
    expect(await waitFor(() => { try { return readFileSync(prefsFile, 'utf8').includes('Mod+Shift+U') } catch { return false } })).toBe(true)
  } finally {
    await closeElectron(app, { keepProfile: true })
  }

  const again = await launched({ reuse: dir })
  app = again.app
  try {
    expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 2)).toBe(true)
    ids = await idsOf(app)
    await waitRecovered(app)
    const chrome = findChrome(app)
    const rpcWc = await openExtensionPage(app, ids.first, 'rpc.html')
    expect(await shortcutOf(app, rpcWc, 'mark')).toBe('Ctrl+Shift+U')
    await navigateToFixture(app, fixtureUrl, 'commands-fixture')

    // The old chord belongs to the other extension's suggestion now; it no longer reaches `mark`.
    await pressKey(app, fixtureUrl, 'K', ['alt', 'shift'])
    await delay(800)
    expect(await commandLog(app, rpcWc)).toEqual([])
    await pressKey(app, fixtureUrl, 'U', ['control', 'shift'])
    expect(await waitFor(async () => (await commandLog(app, rpcWc)).length === 1)).toBe(true)
    expect((await commandLog(app, rpcWc))[0]?.name).toBe('mark')

    const page = await openShortcutsPage(app, chrome)
    const tabsBefore = (await tabIds(chrome)).length

    // Each way a key is refused, named under its row.
    await record(app, page, 'Take the new-tab key', 'T', ['control'])
    await page.waitForSelector('.sc-notice')
    expect(await page.locator('.sc-notice').textContent()).toContain(`"Ctrl+T" is Orivon's shortcut for "New tab". Change it in Settings first.`)
    expect((await tabIds(chrome)).length).toBe(tabsBefore)
    await shoot(page, 'notice-orivon')

    await record(app, page, 'Take the new-tab key', 'K', ['shift'])
    await page.waitForFunction(() => document.querySelector('.sc-notice')?.textContent?.includes('Include Ctrl or Alt.') === true)
    await shoot(page, 'notice-modifier')

    await record(app, page, 'Take the new-tab key', 'C', ['control'])
    await page.waitForFunction(() => document.querySelector('.sc-notice')?.textContent?.includes('Orivon keeps that key for editing.') === true)

    await record(app, page, 'Take the new-tab key', 'U', ['control', 'shift'])
    await page.waitForFunction(() => document.querySelector('.sc-notice')?.textContent?.includes('is used by "Orivon E2E Commands": Mark the current tab.') === true)
    await shoot(page, 'notice-extension')

    // Use it here instead: the key moves, and the old holder shows Not set.
    await page.locator('.sc-notice .btn', { hasText: 'Use it here instead' }).click()
    expect(await waitFor(async () => (await capsOf(rowFor(page, 'Take the new-tab key'))).join('+') === 'Ctrl+Shift+U')).toBe(true)
    expect(await rowFor(page, 'Mark the current tab').locator('.sc-control .muted').textContent()).toBe('Not set')
    // A stopped worker is started by the key.
    await stopWorkers(app, rpcWc)
    await pressKey(app, fixtureUrl, 'U', ['control', 'shift'])
    expect(await waitFor(async () => (await commandLog(app, rpcWc)).length === 2, 20_000)).toBe(true)
    expect((await commandLog(app, rpcWc))[1]?.name).toBe('clash')

    // Remove: Not set, and the key does nothing.
    await rowFor(page, 'Take the new-tab key').locator('.sc-remove').click()
    expect(await waitFor(async () => await rowFor(page, 'Take the new-tab key').locator('.sc-remove').count() === 0)).toBe(true)
    await pressKey(app, fixtureUrl, 'U', ['control', 'shift'])
    await delay(800)
    expect((await commandLog(app, rpcWc)).length).toBe(2)
    expect(await shortcutOf(app, rpcWc, 'clash')).toBe('')

    // The extension's details page links to its shortcuts, and the card is shown outlined.
    await page.locator('.tab-btn', { hasText: 'My extensions' }).click()
    await page.waitForSelector('.ext-list')
    await page.locator('.ext-card', { hasText: 'Orivon E2E Commands' }).locator('a.link-btn', { hasText: 'Details' }).click()
    await page.waitForSelector('#section-shortcuts')
    expect(await page.locator('#section-shortcuts .detail-label').textContent()).toBe('3 commands')
    await shoot(page, 'details-link')
    await page.locator('#section-shortcuts a').click()
    await page.waitForSelector(`#sc-${ids.first}.target`)
    expect(page.url()).toContain(`/shortcuts#${ids.first}`)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says what the page is for when no extension declares a command', async () => {
  const { app } = await launched({ seed: false })
  try {
    const chrome = findChrome(app)
    const page = await openShortcutsPage(app, chrome)
    expect(await page.locator('.empty-state p').textContent()).toBe('Shortcuts of the extensions you add appear here.')
    expect(await page.locator('.empty-state a').count()).toBe(1)
    await shoot(page, 'empty')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
