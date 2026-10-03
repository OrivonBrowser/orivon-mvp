// The window by keyboard: F6 and Shift+F6 walk the address bar, toolbar, tab strip and page; the arrow keys move
// inside the toolbar and the strip; caret browsing turns on from F7 behind a question, reaches every tab, and
// stays on across a cross-origin navigation. Set ORIVON_UI_SHOTS_DIR to also write each surface in both themes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { focusWebContents, underVirtualDisplay, webContentsFocused } from './focus-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { popoverShown, waitFor } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']
const CHROME = '/renderer/index.html'

let server: FixtureServer
let other: FixtureServer
let reloads = 0

beforeAll(async () => {
  server = await startServer((request, response) => {
    reloads += 1
    html(response, `<!doctype html><title>${(request.url ?? '/').slice(1) || 'home'}</title><body style="font:16px sans-serif"><p id="text">Caret browsing moves through this paragraph of words.</p></body>`)
  })
  other = await startServer((_request, response) => { html(response, '<!doctype html><title>other</title><body><p>another origin</p></body>') })
})

afterAll(async () => {
  await server.close()
  await other.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

interface Where { pane: string, id: string, label: string, tab: boolean, tabIndexZero: number }

/** Where keyboard focus is inside the chrome, by pane. */
async function whereInChrome (chrome: Page): Promise<Where> {
  return await chrome.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const pane = active === null || active === document.body ? 'none'
      : active.closest('#address-form') !== null ? 'address'
        : active.closest('#toolbar') !== null ? 'toolbar'
          : active.closest('#tabrow') !== null ? 'tabs'
            : active.closest('#bookmarks-bar') !== null ? 'bookmarks' : 'none'
    const zero = [...document.querySelectorAll<HTMLElement>('.tab, #new-tab, #tab-search')].filter((el) => el.tabIndex === 0).length
    return { pane, id: active?.id ?? '', label: active?.getAttribute('aria-label') ?? '', tab: active?.classList.contains('tab') === true, tabIndexZero: zero }
  })
}

const paneIs = async (chrome: Page, pane: string): Promise<boolean> => (await whereInChrome(chrome)).pane === pane
const expectPane = async (chrome: Page, pane: string): Promise<void> => {
  expect(await waitFor(async () => await paneIs(chrome, pane)), `the keyboard should be in the ${pane} pane`).toBe(true)
}

async function pageFocused (app: App, part: string): Promise<boolean> {
  return await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((wc) => wc.getURL().includes(p))?.isFocused() === true, part)
}

async function focusedUrl (app: App): Promise<string> {
  return await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.isFocused())?.getURL() ?? '')
}

async function shoot (chrome: Page, name: string, target?: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await target?.emulateMedia({ colorScheme: scheme })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await (target ?? chrome).screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await chrome.emulateMedia({ colorScheme: null })
  await target?.emulateMedia({ colorScheme: null })
}

/** The caret flag of every web contents that is one of the fixtures' pages or the new-tab page, by url. */
async function caretByPage (app: App): Promise<Record<string, boolean>> {
  return await app.evaluate(({ webContents }) => Object.fromEntries(webContents.getAllWebContents()
    .filter((wc) => wc.getType() === 'window' && !wc.getURL().includes('/renderer/') && wc.getURL() !== '')
    .map((wc) => [wc.getURL(), wc.isCaretBrowsingEnabled()])))
}

/** The sheet is destroyed when it closes, so the call that answers it can be cut off by its own effect. */
const closedWithTheAnswer = (): void => {}

const sheetPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=caret-confirm'))
const toastPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=toast'))

async function toastReads (app: App, text: string): Promise<boolean> {
  return await waitFor(async () => (await toastPage(app)?.evaluate(() => document.body.textContent ?? '').catch(() => '') ?? '').includes(text))
}

async function newTabAt (app: App, chrome: Page, url: string): Promise<void> {
  await chrome.click('#new-tab')
  await visit(app, chrome, url)
}

it('walks the address bar, toolbar, tabs and page with F6, and back with Shift+F6', async () => {
  const { app, chrome } = await launchShell()
  try {
    const url = `${server.origin}/`
    await visit(app, chrome, url)
    if (underVirtualDisplay()) await focusWebContents(app, url)
    expect(await webContentsFocused(app, url)).toBe(true)

    await pressKey(app, url, 'F6')
    await expectPane(chrome, 'address')
    expect((await whereInChrome(chrome)).id).toBe('address')
    expect(await chrome.evaluate(() => { const input = document.activeElement as HTMLInputElement; return input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0 })).toBe(true)

    await pressKey(app, CHROME, 'F6')
    await expectPane(chrome, 'toolbar')
    expect((await whereInChrome(chrome)).id).not.toBe('address')
    await shoot(chrome, 'ring-toolbar')

    await pressKey(app, CHROME, 'F6')
    await expectPane(chrome, 'tabs')
    expect(await whereInChrome(chrome)).toMatchObject({ tab: true, label: 'home', tabIndexZero: 1 })
    expect(await waitFor(async () => ((await chrome.locator('.sr-only[aria-live]').textContent()) ?? '').includes('Tabs'))).toBe(true)
    await shoot(chrome, 'ring-active-tab')

    // Past the last pane the keyboard is the page's again.
    await pressKey(app, CHROME, 'F6')
    expect(await waitFor(async () => await pageFocused(app, url))).toBe(true)

    // Shift+F6 goes the other way round, wrapping from the address bar to the page.
    await pressKey(app, url, 'F6', ['shift'])
    await expectPane(chrome, 'tabs')
    await pressKey(app, CHROME, 'F6', ['shift'])
    await expectPane(chrome, 'toolbar')
    await pressKey(app, CHROME, 'F6', ['shift'])
    await expectPane(chrome, 'address')
    await pressKey(app, CHROME, 'F6', ['shift'])
    expect(await waitFor(async () => await pageFocused(app, url))).toBe(true)

    // Alt+Shift+T names the toolbar directly, from the page.
    await pressKey(app, url, 'T', ['alt', 'shift'])
    await expectPane(chrome, 'toolbar')
    await pressKey(app, CHROME, 'F6', ['shift'])
    await expectPane(chrome, 'address')
    await pressKey(app, CHROME, 'F6', ['shift'])
    expect(await waitFor(async () => await pageFocused(app, url))).toBe(true)

    // Escape in the strip gives the keyboard back to the page.
    await pressKey(app, url, 'F6', ['shift'])
    await expectPane(chrome, 'tabs')
    await chrome.keyboard.press('Escape')
    expect(await waitFor(async () => await pageFocused(app, url))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('moves between tabs with the arrow keys, activates with Enter, closes with Delete and keeps its place across rebuilds', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${server.origin}/a`)
    await newTabAt(app, chrome, `${server.origin}/b`)
    await newTabAt(app, chrome, `${server.origin}/c`)
    if (underVirtualDisplay()) await focusWebContents(app, `${server.origin}/c`)

    await pressKey(app, `${server.origin}/c`, 'F6')
    await pressKey(app, CHROME, 'F6')
    await pressKey(app, CHROME, 'F6')
    await expectPane(chrome, 'tabs')
    // A tab is named from a state push that follows its page's title by a moment: wait for the name, then read all.
    expect(await waitFor(async () => (await whereInChrome(chrome)).label === 'c')).toBe(true)
    expect(await whereInChrome(chrome)).toMatchObject({ tab: true, label: 'c', tabIndexZero: 1 })

    await chrome.keyboard.press('ArrowLeft')
    expect(await waitFor(async () => (await whereInChrome(chrome)).label === 'b')).toBe(true)
    // One Tab stop in the strip, the tab that has focus; arrows never activate.
    expect((await whereInChrome(chrome)).tabIndexZero).toBe(1)
    expect(await chrome.locator('.tab.active').getAttribute('aria-label')).toBe('c')
    await shoot(chrome, 'ring-tab')

    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await chrome.locator('.tab.active').getAttribute('aria-label')) === 'b')).toBe(true)
    // The strip was rebuilt for the new active tab and focus stayed on b.
    expect(await whereInChrome(chrome)).toMatchObject({ pane: 'tabs', tab: true, label: 'b' })

    await chrome.keyboard.press('Home')
    expect((await whereInChrome(chrome)).label).toBe('a')
    await chrome.keyboard.press('End')
    expect((await whereInChrome(chrome)).id).toBe('tab-search')
    await chrome.keyboard.press('ArrowLeft')
    expect((await whereInChrome(chrome)).id).toBe('new-tab')
    await shoot(chrome, 'ring-new-tab')
    await chrome.keyboard.press('ArrowLeft')
    expect((await whereInChrome(chrome)).label).toBe('c')
    await chrome.keyboard.press('ArrowRight')
    expect((await whereInChrome(chrome)).id).toBe('new-tab')

    // Delete closes the tab that has focus, and focus stays in the strip.
    await chrome.keyboard.press('Home')
    await chrome.keyboard.press('ArrowRight')
    expect((await whereInChrome(chrome)).label).toBe('b')
    await chrome.keyboard.press('Delete')
    expect(await waitFor(async () => (await chrome.locator('.tab').count()) === 2)).toBe(true)
    expect(await waitFor(async () => (await whereInChrome(chrome)).tab)).toBe(true)

    // Enter on the new-tab button is a click.
    await chrome.keyboard.press('End')
    await chrome.keyboard.press('ArrowLeft')
    expect((await whereInChrome(chrome)).id).toBe('new-tab')
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await chrome.locator('.tab').count()) === 3)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('holds the toolbar to one Tab stop, walks it in visual order past disabled buttons, and activates with Space', async () => {
  const { app, chrome } = await launchShell()
  try {
    const url = `${server.origin}/`
    await visit(app, chrome, url)
    if (underVirtualDisplay()) await focusWebContents(app, url)
    await pressKey(app, url, 'F6')
    await pressKey(app, CHROME, 'F6')
    await expectPane(chrome, 'toolbar')

    const expected = await chrome.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('#toolbar button')]
      .filter((el) => el.closest('#address-form') === null && !el.disabled && el.getClientRects().length > 0)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((el) => el.id))
    expect(expected.length).toBeGreaterThan(3)
    expect(expected).toContain('reload')
    expect(expected).toContain('menu')

    const stops = await chrome.evaluate(() => [...document.querySelectorAll<HTMLElement>('#toolbar button')].filter((el) => el.closest('#address-form') === null && el.tabIndex === 0 && !(el as HTMLButtonElement).disabled).length)
    expect(stops).toBe(1)

    await chrome.keyboard.press('Home')
    const walked = [(await whereInChrome(chrome)).id]
    for (let step = 0; step < expected.length + 2; step++) {
      await chrome.keyboard.press('ArrowRight')
      const id = (await whereInChrome(chrome)).id
      if (id === walked.at(-1)) break
      walked.push(id)
    }
    expect(walked).toEqual(expected)
    await chrome.keyboard.press('ArrowLeft')
    expect((await whereInChrome(chrome)).id).toBe(expected.at(-2))
    await chrome.keyboard.press('Home')
    expect((await whereInChrome(chrome)).id).toBe(expected[0])
    await shoot(chrome, 'ring-toolbar-button')

    // Tab leaves the row: the stop moved with focus, so the row still has exactly one.
    await chrome.keyboard.press('End')
    expect((await whereInChrome(chrome)).id).toBe('menu')

    await chrome.evaluate(() => { document.querySelector<HTMLElement>('#reload')?.focus() })
    const before = reloads
    await chrome.keyboard.press('Space')
    expect(await waitFor(() => reloads > before)).toBe(true)

    await chrome.keyboard.press('Escape')
    expect(await waitFor(async () => await pageFocused(app, url))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('turns caret browsing on from F7 behind a question, on every tab and one opened later, and off without asking', async () => {
  const { app, chrome } = await launchShell()
  try {
    const first = `${server.origin}/first`
    await visit(app, chrome, first)
    await newTabAt(app, chrome, `${server.origin}/second`)
    if (underVirtualDisplay()) await focusWebContents(app, `${server.origin}/second`)
    expect(Object.values(await caretByPage(app)).every((on) => !on)).toBe(true)

    // Escape on the sheet changes nothing.
    await pressKey(app, `${server.origin}/second`, 'F7')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=caret-confirm'))).toBe(true)
    expect(await waitFor(() => sheetPage(app) !== undefined)).toBe(true)
    const sheet = sheetPage(app) as Page
    await sheet.waitForSelector('.caret-text')
    expect(await sheet.locator('.sheet-title').textContent()).toBe('Turn on caret browsing?')
    expect(await sheet.locator('.sheet-body').textContent()).toContain('Press F7 to turn it off again.')
    expect(await sheet.evaluate(() => document.activeElement?.textContent)).toBe('Turn on')
    expect(await sheet.locator('.caret').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(380)
    await shoot(chrome, 'caret-sheet', sheet)
    await sheet.keyboard.press('Escape').catch(closedWithTheAnswer)
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=caret-confirm')))).toBe(true)
    expect(Object.values(await caretByPage(app)).every((on) => !on)).toBe(true)

    // Turn on.
    if (underVirtualDisplay()) await focusWebContents(app, `${server.origin}/second`)
    await pressKey(app, `${server.origin}/second`, 'F7')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=caret-confirm'))).toBe(true)
    await (sheetPage(app) as Page).getByRole('button', { name: 'Turn on' }).click().catch(closedWithTheAnswer)
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=caret-confirm')))).toBe(true)
    expect(await waitFor(async () => { const all = await caretByPage(app); return Object.keys(all).length >= 2 && Object.values(all).every(Boolean) })).toBe(true)
    expect(await toastReads(app, 'Caret browsing is on')).toBe(true)
    await shoot(chrome, 'caret-toast', toastPage(app))

    // A tab opened later has it, and so does one that moves to another origin.
    await chrome.click('#new-tab')
    await visit(app, chrome, `${server.origin}/third`)
    expect((await caretByPage(app))[`${server.origin}/third`]).toBe(true)
    await visit(app, chrome, `${other.origin}/`)
    expect(await waitFor(async () => (await caretByPage(app))[`${other.origin}/`] === true)).toBe(true)
    expect((await caretByPage(app))[`${server.origin}/first`]).toBe(true)

    // Off: no question, every tab.
    if (underVirtualDisplay()) await focusWebContents(app, `${other.origin}/`)
    await pressKey(app, `${other.origin}/`, 'F7')
    expect(await waitFor(async () => Object.values(await caretByPage(app)).every((on) => !on))).toBe(true)
    expect(await popoverShown(app, 'overlay=caret-confirm')).toBe(false)
    expect(await toastReads(app, 'Caret browsing is off')).toBe(true)

    // It asks again next time. "Don't ask again" stops the question for good.
    await pressKey(app, `${other.origin}/`, 'F7')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=caret-confirm'))).toBe(true)
    const again = sheetPage(app) as Page
    await again.getByText('Don\'t ask again').click()
    await again.getByRole('button', { name: 'Turn on' }).click().catch(closedWithTheAnswer)
    expect(await waitFor(async () => Object.values(await caretByPage(app)).every(Boolean))).toBe(true)
    await pressKey(app, `${other.origin}/`, 'F7')
    expect(await waitFor(async () => Object.values(await caretByPage(app)).every((on) => !on))).toBe(true)
    await pressKey(app, `${other.origin}/`, 'F7')
    expect(await waitFor(async () => Object.values(await caretByPage(app)).every(Boolean))).toBe(true)
    expect(await popoverShown(app, 'overlay=caret-confirm')).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('turns caret browsing on with no question when the setting says not to ask, and from the Settings toggle', async () => {
  const { app, chrome } = await launchShell({
    seedProfile: (dir) => { writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'accessibility.caretAsk': false } })) }
  })
  try {
    const url = `${server.origin}/quiet`
    await visit(app, chrome, url)
    if (underVirtualDisplay()) await focusWebContents(app, url)
    await pressKey(app, url, 'F7')
    expect(await waitFor(async () => (await caretByPage(app))[url] === true)).toBe(true)
    expect(await popoverShown(app, 'overlay=caret-confirm')).toBe(false)
    await pressKey(app, url, 'F7')
    expect(await waitFor(async () => (await caretByPage(app))[url] === false)).toBe(true)

    // The Accessibility section's Keyboard group holds the two toggles and the F6 note, and its toggle reaches the tabs.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/accessibility') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-caret-browsing')
    expect(await settings.locator('#row-caret-browsing .row-label').textContent()).toBe('Navigate pages with a text cursor')
    expect(await settings.locator('#row-caret-browsing .row-help').textContent()).toBe('Also called caret browsing. Press F7 to turn it on or off.')
    expect(await settings.locator('#row-caret-ask .row-label').textContent()).toBe('Ask before turning on caret browsing with F7')
    expect(await settings.locator('#row-caret-ask input').isChecked()).toBe(false)
    expect(await settings.locator('#row-pane-keys .value').textContent()).toBe('F6')
    await shoot(chrome, 'settings-keyboard', settings)

    await settings.locator('#row-caret-browsing .row-label').click()
    expect(await waitFor(async () => (await caretByPage(app))[url] === true)).toBe(true)
    await settings.locator('#row-caret-browsing .row-label').click()
    expect(await waitFor(async () => (await caretByPage(app))[url] === false)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('stops at the bookmarks bar between the tabs and the page when it has something to focus', async () => {
  const { app, chrome } = await launchShell({
    seedProfile: (dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'appearance.bookmarksBar': 'always' } }))
      writeFileSync(join(dir, 'bookmarks.json'), JSON.stringify([
        { url: `${server.origin}/one`, title: 'First page', favicon: null },
        { url: `${server.origin}/two`, title: 'Second page', favicon: null }
      ]))
    }
  })
  try {
    const url = `${server.origin}/`
    await visit(app, chrome, url)
    expect(await waitFor(async () => (await chrome.locator('#bookmarks-list .bmitem').count()) === 2)).toBe(true)
    if (underVirtualDisplay()) await focusWebContents(app, url)
    await pressKey(app, url, 'F6')
    for (const pane of ['toolbar', 'tabs', 'bookmarks']) {
      await pressKey(app, CHROME, 'F6')
      await expectPane(chrome, pane)
    }
    expect(await chrome.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('First page')
    await shoot(chrome, 'ring-bookmark')
    await chrome.keyboard.press('ArrowRight')
    expect(await chrome.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Second page')
    await pressKey(app, CHROME, 'F6')
    expect(await waitFor(async () => await pageFocused(app, url))).toBe(true)
    await pressKey(app, url, 'F6', ['shift'])
    await expectPane(chrome, 'bookmarks')
    // The pane remembers where it was.
    expect(await chrome.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Second page')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
