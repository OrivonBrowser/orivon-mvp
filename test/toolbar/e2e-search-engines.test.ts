// Keywords, the engines list in Settings and the engine's own suggestions, in the running shell. A fixture on
// port 0 stands in for the search engine: /search and /kw answer a search, /suggest answers a typed prefix and
// records what the request carried. No real engine is ever reached. Set ORIVON_UI_SHOTS_DIR to also write
// screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, popoverShown, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR

interface Seen { path: string, cookie: string | undefined, referer: string | undefined }
const WORDS = ['hello world', 'help desk', 'hero movie', 'heat map', 'hedgehog']

let server: FixtureServer
let seen: Seen[] = []

beforeAll(async () => {
  server = await startServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test')
    seen.push({ path: `${url.pathname}?${url.searchParams.toString()}`, cookie: request.headers.cookie, referer: request.headers.referer })
    if (url.pathname === '/suggest') {
      const q = url.searchParams.get('q') ?? ''
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([q, WORDS.filter((word) => word.startsWith(q.toLowerCase()))]))
      return
    }
    if (url.pathname === '/login') response.setHeader('set-cookie', 'sid=abc; Path=/')
    const title = url.pathname === '/login' ? 'Logged in' : `Found ${url.searchParams.get('q') ?? ''}`
    html(response, `<!doctype html><title>${title}</title><body style="font:16px sans-serif"><h1>${title}</h1></body>`)
  })
})
beforeEach(() => { seen = [] })
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication
const suggestRequests = (): Seen[] => seen.filter((request) => request.path.startsWith('/suggest'))

/** A profile whose Web2 engine is the fixture, the engine `fx` searching it at /kw, and any more files. It searches the Web2 unless told the Web3, or told to leave the mode unset, as a fresh profile has it. */
function seed (more: { suggestions?: boolean, engines?: boolean, mode?: 'web3' | 'web2' | 'unset' } = {}) {
  return async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
    const values: Record<string, unknown> = { 'search.engine': 'custom', 'search.customUrl': `${server.origin}/search?q=%s` }
    if (more.mode !== 'unset') values['search.mode'] = more.mode ?? 'web2'
    if (more.suggestions === true) values['search.suggestions'] = true
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values }))
    if (more.engines !== false) {
      writeFileSync(join(dir, 'search-engines.json'), JSON.stringify({
        version: 1, removedSeeds: [], engines: [{ id: 'e-fx', name: 'Fixture', keyword: 'fx', template: `${server.origin}/kw?q=%s` }]
      }))
    }
  }
}
const envFor = (): Record<string, string> => ({ ORIVON_TEST_SUGGEST_URL: `${server.origin}/suggest?q=%s` })

const overlayOf = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=omnibox'))
const shown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=omnibox')
const rowsOf = async (app: App): Promise<string[]> => await overlayOf(app)?.locator('.listbox-item').allInnerTexts() ?? []

async function waitForRows (app: App, count = 1): Promise<string[]> {
  expect(await waitFor(async () => (await shown(app)) && (await rowsOf(app)).length >= count)).toBe(true)
  return await rowsOf(app)
}

async function typeInBar (chrome: Page, text: string): Promise<void> {
  await chrome.click('#address')
  await chrome.keyboard.press('ControlOrMeta+A')
  await chrome.keyboard.type(text, { delay: 25 })
}

const tabAddresses = async (app: App): Promise<string[]> =>
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL()).filter((url) => url.startsWith('http://127.0.0.1')))

async function loadInTab (app: App, chrome: Page, address: string): Promise<void> {
  await chrome.click('#address')
  await chrome.fill('#address', address)
  await chrome.press('#address', 'Enter')
  expect(await waitFor(async () => (await tabAddresses(app)).includes(address))).toBe(true)
  expect(await waitFor(async () => (await activeTabInfo(chrome)).address === address)).toBe(true)
}

async function openTab (chrome: Page): Promise<void> {
  const before = (await tabIds(chrome)).length
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('tab.new') })
  expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
}

async function openSettings (app: App, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/search') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('#row-search-engines .engine-item')
  return page
}

const userDataOf = async (app: App): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

async function shootPage (app: App, page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme }, scheme)
    await page.emulateMedia({ colorScheme: scheme })
    await delay(300)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system' })
  await page.emulateMedia({ colorScheme: null })
}

async function shootDropdown (app: App, chrome: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  const overlay = overlayOf(app)
  for (const scheme of ['light', 'dark'] as const) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme }, scheme)
    await chrome.emulateMedia({ colorScheme: scheme })
    await overlay?.emulateMedia({ colorScheme: scheme })
    await delay(400)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)])
    if (overlay !== undefined) await overlay.screenshot({ path: join(SHOTS_DIR, `${name}-rows-${scheme}.png`) })
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system' })
  await chrome.emulateMedia({ colorScheme: null })
  await overlay?.emulateMedia({ colorScheme: null })
}

const itemNamed = (page: Page, name: string): ReturnType<Page['locator']> => page.locator('.engine-item', { has: page.locator('.engine-name', { hasText: new RegExp(`^${name}$`) }) })
const formInput = (page: Page, label: string): ReturnType<Page['locator']> => page.locator('.engine-form .field', { hasText: label }).locator('input')

it('lists the engines in Settings, adds, edits, removes and makes one the default, and refuses a keyword already used', async () => {
  const { app, chrome } = await launchShell()
  try {
    const page = await openSettings(app, chrome)
    const names = await page.locator('.engine-item .engine-name').allInnerTexts()
    expect(names).toEqual(['DuckDuckGo', 'Startpage', 'Brave Search', 'Ecosia', 'Qwant', 'Mojeek', 'Bing', 'Google', 'Wikipedia', 'YouTube', 'GitHub', 'OpenStreetMap'])
    expect(await page.locator('.engine-item kbd').allInnerTexts()).toEqual(['ddg', 'sp', 'brave', 'eco', 'qw', 'mj', 'bing', 'g', 'w', 'yt', 'gh', 'map'])
    expect(await itemNamed(page, 'DuckDuckGo').locator('.badge.ok').innerText()).toBe('Default')
    // Built-in engines offer neither Edit nor Remove; site engines offer both.
    expect(await itemNamed(page, 'Google').locator('.engine-edit, .engine-remove').count()).toBe(0)
    expect(await itemNamed(page, 'Wikipedia').locator('.engine-edit, .engine-remove').count()).toBe(2)
    // The page draws itself again as each part of its state arrives, so the row can be replaced while a locator action waits for it to hold still.
    await page.evaluate(() => { document.querySelector('#row-search-engines')?.scrollIntoView({ block: 'nearest' }) })
    await shootPage(app, page, 'settings-engines')

    // The form opens on Name; Enter saves.
    await page.locator('.engine-add').click()
    expect(await page.evaluate(() => document.activeElement === document.querySelector('.engine-form .field input'))).toBe(true)
    await formInput(page, 'Name').fill('Fixture')
    await formInput(page, 'Keyword').fill('w')
    await formInput(page, 'Address').fill(`${server.origin}/kw?q=%s`)
    await page.keyboard.press('Enter')
    expect(await page.locator('.engine-form .problem', { hasText: 'already used by Wikipedia' }).count()).toBe(1)
    expect(await formInput(page, 'Keyword').getAttribute('aria-invalid')).toBe('true')
    await formInput(page, 'Address').fill('https://example.org/search')
    await formInput(page, 'Keyword').fill('fx')
    await page.keyboard.press('Enter')
    expect(await page.locator('.engine-form .problem', { hasText: 'Use an address that starts with' }).count()).toBe(1)
    await shootPage(app, page, 'settings-engines-form-error')
    await formInput(page, 'Address').fill(`${server.origin}/kw?q=%s`)
    await page.keyboard.press('Enter')
    await page.waitForSelector('.engine-form', { state: 'hidden' })
    expect(await itemNamed(page, 'Fixture').locator('kbd').innerText()).toBe('fx')

    // Escape cancels an edit without changing the engine.
    await itemNamed(page, 'Fixture').locator('.engine-edit').click()
    expect(await formInput(page, 'Name').inputValue()).toBe('Fixture')
    await formInput(page, 'Name').fill('Changed')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.engine-form', { state: 'hidden' })
    expect(await itemNamed(page, 'Fixture').count()).toBe(1)
    await itemNamed(page, 'Fixture').locator('.engine-edit').click()
    await formInput(page, 'Name').fill('Fixture site')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.engine-form', { state: 'hidden' })
    expect(await itemNamed(page, 'Fixture site').count()).toBe(1)

    // The file on disk follows.
    const file = join(await userDataOf(app), 'search-engines.json')
    expect(await waitFor(async () => (await readFile(file, 'utf8').catch(() => '')).includes('Fixture site'))).toBe(true)

    // Make default on the person's own engine picks Custom and its address, and the badge moves there.
    await itemNamed(page, 'Fixture site').locator('.engine-default').click()
    expect(await waitFor(async () => (await itemNamed(page, 'Fixture site').locator('.badge.ok').count()) === 1)).toBe(true)
    expect(await itemNamed(page, 'DuckDuckGo').locator('.badge.ok').count()).toBe(0)
    expect(await page.locator('#row-search-engine select').inputValue()).toBe('custom')
    expect(await page.locator('#row-search-custom-url input').inputValue()).toBe(`${server.origin}/kw?q=%s`)
    // A default that offers no suggestions says so and the switch is off limits.
    expect(await page.locator('#row-search-suggestions input').isDisabled()).toBe(true)
    expect(await page.locator('#row-search-suggestions .row-help').innerText()).toBe('Fixture site does not offer suggestions.')

    await itemNamed(page, 'Google').locator('.engine-default').click()
    expect(await waitFor(async () => (await itemNamed(page, 'Google').locator('.badge.ok').count()) === 1)).toBe(true)
    expect(await page.locator('#row-search-engine select').inputValue()).toBe('google')
    expect(await page.locator('#row-search-suggestions input').isDisabled()).toBe(false)
    expect(await page.locator('#row-search-suggestions .row-help').innerText()).toContain('Orivon sends what you type to Google.')

    // Remove asks twice, and a removed starting engine stays removed.
    await itemNamed(page, 'YouTube').locator('.engine-remove').click()
    expect(await itemNamed(page, 'YouTube').locator('.engine-remove').count()).toBe(0)
    await itemNamed(page, 'YouTube').locator('button.armed').click()
    expect(await waitFor(async () => (await itemNamed(page, 'YouTube').count()) === 0)).toBe(true)
    expect(await waitFor(async () => (await readFile(file, 'utf8').catch(() => '')).includes('seed-youtube'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('searches the engine a keyword names, and only for a whole first word followed by text', async () => {
  const { app, chrome } = await launchShell({ seedProfile: seed() })
  try {
    await typeInBar(chrome, 'fx hello')
    const rows = await waitForRows(app, 1)
    expect(rows[0]).toContain('hello')
    expect(rows[0]).toContain('Search Fixture')
    await shootDropdown(app, chrome, 'search-engines-keyword')
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/kw?q=hello`))).toBe(true)

    // Whatever the case, and the terms are encoded as a search box does.
    await openTab(chrome)
    await typeInBar(chrome, 'FX Big Cats')
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/kw?q=Big+Cats`))).toBe(true)

    // A keyword alone is an ordinary search of the default engine.
    await openTab(chrome)
    await typeInBar(chrome, 'fx')
    const alone = await waitForRows(app, 1)
    expect(alone[0]).not.toContain('Search Fixture')
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/search?q=fx`))).toBe(true)

    // A keyword never takes the place of an address.
    await openTab(chrome)
    await typeInBar(chrome, 'fx.com')
    expect((await waitForRows(app, 1))[0]).toContain('Go to address')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('asks the engine for suggestions only when the setting is on, and sends nothing with the request', async () => {
  // Off, the default: nothing is requested however the text is typed.
  const off = await launchShell({ seedProfile: seed(), env: envFor() })
  try {
    await typeInBar(off.chrome, 'he')
    expect((await waitForRows(off.app, 1))[0]).toContain('he')
    await delay(ABSENCE_SETTLE_MS + 400)
    expect(suggestRequests()).toEqual([])
    expect(await rowsOf(off.app)).toHaveLength(1)
  } finally {
    await closeElectron(off.app)
  }

  const { app, chrome } = await launchShell({ seedProfile: seed({ suggestions: true }), env: envFor() })
  try {
    // A cookie the engine's own site set, so a request that carried cookies would show it.
    await loadInTab(app, chrome, `${server.origin}/login`)
    await openTab(chrome)
    await typeInBar(chrome, 'he')
    const rows = await waitForRows(app, 5)
    expect(rows.slice(1).map((row) => row.trim())).toEqual(['hello world', 'help desk', 'hero movie', 'heat map'])
    expect(rows[0]).toContain('he')
    expect(suggestRequests()).toHaveLength(1)
    expect(suggestRequests()[0]).toMatchObject({ path: '/suggest?q=he', cookie: undefined, referer: undefined })
    await shootDropdown(app, chrome, 'search-engines-suggestions')

    // None for an address, a keyword search or one character.
    const before = suggestRequests().length
    for (const text of ['127.0.0.1:1234/x', 'fx hello', 'h']) {
      await typeInBar(chrome, text)
      await waitForRows(app, 1)
      await delay(ABSENCE_SETTLE_MS + 400)
      expect(suggestRequests()).toHaveLength(before)
    }

    // Picking one searches it, through the default engine and not through a keyword reading.
    await typeInBar(chrome, 'he')
    await waitForRows(app, 5)
    await chrome.keyboard.press('ArrowDown')
    expect((await chrome.evaluate(() => (document.querySelector('#address') as HTMLInputElement).value))).toBe('hello world')
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/search?q=hello+world`))).toBe(true)
    // The page request did carry the engine site's cookie: only the suggestion request went without.
    expect(seen.find((request) => request.path === '/search?q=hello+world')?.cookie).toContain('sid=abc')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('asks for no suggestions in a private window, keeps keywords, and shows the list read-only', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private'], seedProfile: seed({ suggestions: true }), env: envFor() })
  try {
    await typeInBar(chrome, 'he')
    expect((await waitForRows(app, 1))[0]).toContain('he')
    await delay(ABSENCE_SETTLE_MS + 400)
    expect(suggestRequests()).toEqual([])

    await typeInBar(chrome, 'fx hello')
    expect((await waitForRows(app, 1))[0]).toContain('Search Fixture')
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/kw?q=hello`))).toBe(true)

    const page = await openSettings(app, chrome)
    expect(await itemNamed(page, 'Fixture').count()).toBe(1)
    expect(await page.locator(':is(.engine-add, .engine-edit, .engine-remove):visible').count()).toBe(0)
    expect(await page.locator('.engine-note').isVisible()).toBe(true)
    expect(await page.locator('#row-search-suggestions input').isDisabled()).toBe(true)
    expect(await page.locator('#row-search-suggestions .row-help').innerText()).toBe('Not used in a private window.')
    await shootPage(app, page, 'settings-engines-private')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

const chipOf = (chrome: Page): ReturnType<Page['locator']> => chrome.locator('#search-mode')
const addressOf = async (chrome: Page): Promise<string> => String((await activeTabInfo(chrome) as { address?: string }).address)

it('searches the Web3 with Explore on a fresh profile, switches to the Web2 from the chip, and keeps the choice in Settings', async () => {
  const { app, chrome } = await launchShell({ seedProfile: seed({ mode: 'unset', engines: false }) })
  try {
    // A new tab shows the chip with the mode on; it names both engines.
    expect(await waitFor(async () => await chipOf(chrome).isVisible())).toBe(true)
    expect(await chipOf(chrome).innerText()).toBe('Web3')
    expect(await chipOf(chrome).getAttribute('aria-pressed')).toBe('true')
    expect(await chipOf(chrome).getAttribute('aria-label')).toBe('Searching Web3 with Explore. Click to search Web2.')
    await shootDropdown(app, chrome, 'search-mode-chip')

    await typeInBar(chrome, 'free speech')
    expect((await waitForRows(app, 1))[0]).toContain('Explore')
    await chrome.keyboard.press('Enter')
    // The page itself cannot load without an IPFS route; the tab is sent to Explore's address, which is what is checked.
    expect(await waitFor(async () => (await addressOf(chrome)) === 'ipfs://explore.orivonstack.eth/#/search?q=free+speech')).toBe(true)

    // The chip does not take the keyboard from the field, and the open dropdown names the other engine afterwards.
    await openTab(chrome)
    await typeInBar(chrome, 'cats')
    expect((await waitForRows(app, 1))[0]).toContain('Explore')
    await chipOf(chrome).click()
    expect(await waitFor(async () => (await chipOf(chrome).innerText()) === 'Web2')).toBe(true)
    expect(await chipOf(chrome).getAttribute('aria-pressed')).toBe('false')
    expect(await chrome.evaluate(() => document.activeElement?.id)).toBe('address')
    expect(await waitFor(async () => !(await rowsOf(app))[0]?.includes('Explore'))).toBe(true)
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/search?q=cats`))).toBe(true)

    // The chip is gone beside a loaded page's address, so it never reads as that site's own level.
    expect(await waitFor(async () => !(await chipOf(chrome).isVisible()))).toBe(true)

    // Settings holds the same choice, and changing it there moves the chip.
    const page = await openSettings(app, chrome)
    expect(await page.locator('#row-search-mode select').inputValue()).toBe('web2')
    expect(await page.locator('#row-search-web3-engine select').inputValue()).toBe('explore')
    await page.locator('#row-search-mode select').selectOption('web3')
    await chrome.click('#address')
    expect(await waitFor(async () => (await chipOf(chrome).innerText()) === 'Web3')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
