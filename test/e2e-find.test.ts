// Find in page and Stop in the running shell: the bar opens on the key, counts
// live while the person types, steps and toggles case, closes on Escape and
// keeps the selection, and a tab switch closes it and gives it back with the
// query. The reload button always reloads, so a click while a page loads restarts
// the load, and Escape stops it.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import type { ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { delay, popoverShown, waitFor, waitForTab } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR

let server: FixtureServer
const held: ServerResponse[] = []
const heldImages: ServerResponse[] = []
const requests = new Map<string, number>()
const seen = (path: string): number => requests.get(path) ?? 0

const WORDS = 'orivon Orivon ORIVON orivon Orivon'
const repeated = (n: number): string => Array.from({ length: n }, (_, i) => `<p>line ${String(i)} orivon</p>`).join('')

beforeAll(async () => {
  server = await startServer((request, response) => {
    requests.set(request.url ?? '', seen(request.url ?? '') + 1)
    if (request.url === '/hang') {
      // No headers at all: the navigation never commits.
      held.push(response)
      return
    }
    if (request.url === '/slowimg') {
      // Committed at once, but its load goes on until the image answers.
      html(response, '<!doctype html><title>slowimg</title><p>waiting for an image</p><img src="/image-held" alt="">')
      return
    }
    if (request.url === '/image-held') {
      heldImages.push(response)
      return
    }
    if (request.url === '/slow') {
      // Headers and a first chunk, then silence: the load is still going until the test ends it.
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<!doctype html><title>slow</title><p>waiting</p>')
      held.push(response)
      return
    }
    if (request.url === '/many') { html(response, `<!doctype html><title>many</title><body style="font:16px sans-serif">${repeated(17)}</body>`); return }
    html(response, `<!doctype html><title>words</title><body style="font:16px sans-serif"><p>${WORDS}</p><p>nothing else here</p></body>`)
  })
})

afterAll(async () => {
  for (const response of [...held, ...heldImages]) response.destroy()
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const barPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=find'))
const barShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=find')
const countOf = async (bar: Page): Promise<string> => (await bar.locator('.find-count').textContent()) ?? ''

/** Waits for the count to read `text`; a miss says what it read instead. */
async function expectCount (bar: Page, text: string): Promise<void> {
  let last = ''
  const ok = await waitFor(async () => { last = await countOf(bar); return last === text })
  expect({ ok, last }).toEqual({ ok: true, last: text })
}

async function openBar (app: App, tabUrlPart: string): Promise<Page> {
  await pressKey(app, tabUrlPart, 'F', ['control'])
  expect(await waitFor(async () => await barShown(app))).toBe(true)
  expect(await waitFor(() => barPage(app) !== undefined)).toBe(true)
  const bar = barPage(app) as Page
  await bar.waitForSelector('.find-input')
  return bar
}

/** Whether the overlay's own webContents holds keyboard focus, and whether the page's input holds it inside. */
async function barHasFocus (app: App, bar: Page): Promise<{ contents: boolean, input: boolean }> {
  const contents = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('overlay=find'))?.isFocused() === true)
  const input = await bar.evaluate(() => document.activeElement?.classList.contains('find-input') === true)
  return { contents, input }
}

const tabFocused = async (app: App, part: string): Promise<boolean> =>
  await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((wc) => wc.getURL().includes(p))?.isFocused() === true, part)

const selectionOf = async (page: Page): Promise<string> => await page.evaluate(() => String(window.getSelection()))

async function settled (app: App, part: string): Promise<void> {
  expect(await waitFor(async () => await app.evaluate(({ webContents }, p) => {
    const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL().includes(p))
    return wc !== undefined && !wc.isLoading()
  }, part))).toBe(true)
}

async function shoot (app: App, chrome: Page, bar: Page | undefined, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await bar?.emulateMedia({ colorScheme: scheme })
    await delay(300)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)])
    if (bar !== undefined) await bar.screenshot({ path: join(SHOTS_DIR, `${name}-bar-${scheme}.png`) })
  }
  await chrome.emulateMedia({ colorScheme: null })
  await bar?.emulateMedia({ colorScheme: null })
  expect(app).toBeDefined()
}

it('opens on the key, keeps typing focus while it searches, counts, steps and toggles case', async () => {
  const { app, chrome } = await launchShell()
  try {
    const page = await visit(app, chrome, `${server.origin}/`)
    await settled(app, server.origin)
    expect(await barShown(app)).toBe(false)

    const bar = await openBar(app, server.origin)
    expect(await bar.locator('.findbar').evaluate((el) => el.getBoundingClientRect().height)).toBe(44)
    expect(await waitFor(async () => (await barHasFocus(app, bar)).input)).toBe(true)

    // Typing with the search running must not lose the keys: measured after every character.
    const focusAfterEach: Array<{ contents: boolean, input: boolean }> = []
    for (const character of 'orivon') {
      await bar.keyboard.press(character)
      await delay(120)
      focusAfterEach.push(await barHasFocus(app, bar))
    }
    expect(focusAfterEach.every((state) => state.input)).toBe(true)
    expect(focusAfterEach.every((state) => state.contents)).toBe(true)
    await expectCount(bar, '1 of 5')
    expect(await bar.locator('.find-input').inputValue()).toBe('orivon')

    await bar.keyboard.press('Enter')
    await expectCount(bar, '2 of 5')
    await bar.keyboard.press('Shift+Enter')
    await expectCount(bar, '1 of 5')
    await bar.keyboard.press('Shift+Enter')
    await expectCount(bar, '5 of 5')
    await bar.getByRole('button', { name: 'Next match (Enter)' }).click()
    await expectCount(bar, '1 of 5')
    expect(await barHasFocus(app, bar)).toMatchObject({ contents: true })

    await shoot(app, chrome, bar, 'find-count')

    // Tab walks input, previous, next, match case, close, in that order.
    const order: string[] = []
    await bar.locator('.find-input').focus()
    for (let press = 0; press < 4; press += 1) {
      await bar.keyboard.press('Tab')
      order.push(await bar.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''))
    }
    expect(order).toEqual(['Previous match (Shift+Enter)', 'Next match (Enter)', 'Match case', 'Close (Esc)'])
    await bar.locator('.find-input').focus()

    // Match case: "orivon" exactly is two of the five.
    await bar.getByRole('button', { name: 'Match case' }).click()
    expect(await bar.getByRole('button', { name: 'Match case' }).getAttribute('aria-pressed')).toBe('true')
    await expectCount(bar, '1 of 2')
    await bar.getByRole('button', { name: 'Match case' }).click()
    await expectCount(bar, '1 of 5')

    // No match: the words, the red border and disabled steppers.
    await bar.locator('.find-input').fill('zzz')
    await expectCount(bar, 'No results')
    expect(await bar.locator('.find-input').getAttribute('aria-invalid')).toBe('true')
    expect(await bar.getByRole('button', { name: 'Next match (Enter)' }).isDisabled()).toBe(true)
    await shoot(app, chrome, bar, 'find-none')

    // Escape keeps the match selected in the page, closes the bar and gives the page the keys back.
    await bar.locator('.find-input').fill('orivon')
    await expectCount(bar, '1 of 5')
    await bar.keyboard.press('Enter')
    await expectCount(bar, '2 of 5')
    await bar.keyboard.press('Escape')
    expect(await waitFor(async () => !(await barShown(app)))).toBe(true)
    expect(await waitFor(async () => await tabFocused(app, server.origin))).toBe(true)
    expect((await selectionOf(page)).toLowerCase()).toBe('orivon')

    // Find next with the bar closed brings it back with the query, one step on.
    await pressKey(app, server.origin, 'G', ['control'])
    expect(await waitFor(async () => await barShown(app))).toBe(true)
    expect(await bar.locator('.find-input').inputValue()).toBe('orivon')
    await expectCount(bar, '2 of 5')
    // With it open, the keys step from the bar too, and F3 is the alias.
    await pressKey(app, 'overlay=find', 'G', ['control', 'shift'])
    await expectCount(bar, '1 of 5')
    expect(await barHasFocus(app, bar)).toMatchObject({ contents: true })

    // The key again while open: focus comes back and the text is selected.
    await page.evaluate(() => { document.body.focus() })
    await pressKey(app, server.origin, 'F', ['control'])
    expect(await waitFor(async () => (await barHasFocus(app, bar)).contents)).toBe(true)
    expect(await bar.evaluate(() => { const input = document.querySelector<HTMLInputElement>('.find-input'); return input?.selectionStart === 0 && input.selectionEnd === input.value.length })).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('shows "3 of 17" for a longer page, and a click in the page leaves the bar open', async () => {
  const { app, chrome } = await launchShell()
  try {
    const page = await visit(app, chrome, `${server.origin}/many`)
    await settled(app, '/many')
    const bar = await openBar(app, '/many')
    await bar.keyboard.type('orivon')
    await expectCount(bar, '1 of 17')
    await bar.keyboard.press('Enter')
    await bar.keyboard.press('Enter')
    await expectCount(bar, '3 of 17')
    await shoot(app, chrome, bar, 'find-17')

    await page.click('body')
    await delay(400)
    expect(await barShown(app)).toBe(true)
    expect(await countOf(bar)).toBe('3 of 17')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('closes on a tab switch, clears the old tab, and gives the bar back with its query when the tab returns', async () => {
  const { app, chrome } = await launchShell()
  try {
    const page = await visit(app, chrome, `${server.origin}/`)
    await settled(app, server.origin)
    const bar = await openBar(app, server.origin)
    await bar.keyboard.type('orivon')
    await expectCount(bar, '1 of 5')

    await chrome.click('#new-tab')
    expect(await waitFor(async () => !(await barShown(app)))).toBe(true)
    expect(await selectionOf(page)).toBe('')

    await chrome.locator('.tab').first().click()
    expect(await waitFor(async () => await barShown(app))).toBe(true)
    await expectCount(bar, '1 of 5')
    expect(await bar.locator('.find-input').inputValue()).toBe('orivon')

    // A navigation in the same tab leaves the bar open and searches the new page when it has loaded.
    await clickAddressBarRetrying(chrome, `${server.origin}/many`)
    expect((await waitForTab(chrome, { address: `${server.origin}/many` })).ok).toBe(true)
    await expectCount(bar, '1 of 17')
    expect(await barShown(app)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('works on an internal page', async () => {
  const { app, chrome } = await launchShell()
  try {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('settings') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('.nav-item')
    const bar = await openBar(app, 'orivon://settings')
    await bar.keyboard.type('Appearance')
    expect(await waitFor(async () => /^1 of [1-9]\d*$/.test(await countOf(bar)))).toBe(true)
    await bar.keyboard.press('Escape')
    expect(await waitFor(async () => !(await barShown(app)))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

/** Clicks the button at its centre with a raw mouse press: Playwright's own click waits for navigations. */
async function mouseClick (chrome: Page, selector: string): Promise<void> {
  const box = await chrome.locator(selector).boundingBox()
  if (box === null) throw new Error(`${selector} has no box`)
  await chrome.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const tabLoading = async (app: App, part: string): Promise<boolean | undefined> =>
  await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((wc) => wc.getURL().includes(p))?.isLoading(), part)

it('restarts the load when reload is clicked during it, and Escape stops it', async () => {
  const { app, chrome } = await launchShell()
  const problems: string[] = []
  chrome.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()) })
  chrome.on('pageerror', (error) => { problems.push(error.message) })
  try {
    await visit(app, chrome, `${server.origin}/`)
    const reload = chrome.locator('#reload')
    expect(await reload.getAttribute('aria-label')).toBe('Reload')

    await clickAddressBarRetrying(chrome, `${server.origin}/slow`)
    expect(await waitFor(async () => (await tabLoading(app, '/slow')) === true)).toBe(true)
    // Long enough that a button that swaps to Stop after a short delay would have done so.
    await delay(400)
    expect(await reload.getAttribute('aria-label')).toBe('Reload')
    expect(await reload.getAttribute('title')).toBeNull()
    const before = seen('/slow')
    await mouseClick(chrome, '#reload')
    expect(await waitFor(() => seen('/slow') === before + 1)).toBe(true)
    expect(await tabLoading(app, '/slow')).toBe(true)
    expect(await reload.getAttribute('aria-label')).toBe('Reload')

    await pressKey(app, '/slow', 'Escape')
    expect(await waitFor(async () => (await tabLoading(app, '/slow')) === false)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
    expect(problems).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('restarts a navigation that has not answered yet, and does not reload the page before it', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${server.origin}/`)
    const roots = seen('/')
    await app.evaluate(({ webContents }, origin) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL() === `${origin}/`)
      void wc?.executeJavaScript("location.href = '/hang'")
    }, server.origin)
    expect(await waitFor(() => seen('/hang') === 1)).toBe(true)

    await mouseClick(chrome, '#reload')
    expect(await waitFor(() => seen('/hang') === 2)).toBe(true)
    await delay(300)
    expect(seen('/')).toBe(roots)
    expect(seen('/hang')).toBe(2)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('restarts a navigation the page being left outlives, once that page finishes its own load', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${server.origin}/`)
    const navigate = async (from: string, to: string): Promise<void> => {
      const tab = app.windows().find((w) => w.url() === `${server.origin}${from}`)
      expect(tab).toBeDefined()
      void tab?.evaluate((next) => { location.href = next }, to).catch(() => {})
    }
    const hangs = seen('/hang')
    await navigate('/', '/slowimg')
    expect(await waitFor(() => seen('/image-held') === 1)).toBe(true)
    await navigate('/slowimg', '/hang')
    expect(await waitFor(() => seen('/hang') === hangs + 1)).toBe(true)
    const shown = seen('/slowimg')

    for (const response of heldImages) response.end()
    await delay(500)
    await mouseClick(chrome, '#reload')
    expect(await waitFor(() => seen('/hang') === hangs + 2)).toBe(true)
    await delay(300)
    expect(seen('/slowimg')).toBe(shown)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
