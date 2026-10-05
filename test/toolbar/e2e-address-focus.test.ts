// The address field and the keyboard. Enter and Escape hand the keyboard to the page, and a tab switch with the field
// focused shows the new tab's address, so Enter cannot load the old tab's address into it. An edit kept while the
// keyboard is in another app or the page is src/renderer/tests/navigation.test.ts's: the headless display delivers
// no blur to the chrome's document when a window or a sibling view takes the keyboard, so the first click after a window
// refocus (a caret under the old rule) is covered there and by src/renderer/tests/address-select.test.ts only. A new tab
// opened in front starts with the keyboard in the bar, and the first click on the bar selects its address.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCommand } from '../support/auth-support.js'
import { pressKey } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const CHROME = '/renderer/index.html'
let server: FixtureServer

beforeAll(async () => {
  server = await startServer((req, res) => {
    const name = (req.url ?? '/').slice(1) || 'home'
    html(res, `<!doctype html><title>${name}</title><p>${name}</p>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const focusedAt = async (app: ElectronApplication, part: string): Promise<boolean> =>
  await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((wc) => wc.getURL().includes(p))?.isFocused() === true, part)
const address = async (chrome: Page): Promise<string> => await chrome.inputValue('#address')

it('hands the keyboard to the page after Enter in the address bar, and after Escape leaves it', async () => {
  const { app, chrome } = await launchShell()
  try {
    const one = `${server.origin}/one`
    await visit(app, chrome, one)
    expect(await waitFor(async () => await focusedAt(app, one))).toBe(true)

    await runCommand(chrome, 'nav.focusAddress')
    expect(await waitFor(async () => await focusedAt(app, CHROME))).toBe(true)
    await pressKey(app, CHROME, 'Escape')
    expect(await waitFor(async () => await focusedAt(app, one))).toBe(true)
    expect(await address(chrome)).toBe(one)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('shows the new tab\'s address when the tab changes under a focused, edited field', async () => {
  const { app, chrome } = await launchShell()
  try {
    const one = `${server.origin}/one`
    const two = `${server.origin}/two`
    await visit(app, chrome, one)
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (url: string) => void } }).orivonShell.newTab(url) }, two)
    expect((await waitForTab(chrome, { address: two })).ok).toBe(true)

    await runCommand(chrome, 'nav.focusAddress')
    await chrome.fill('#address', 'typed for the second tab')
    await runCommand(chrome, 'tab.previous')
    expect((await waitForTab(chrome, { title: 'one' })).ok).toBe(true)
    expect(await waitFor(async () => await address(chrome) === one)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

const selection = async (chrome: Page): Promise<{ start: number | null, end: number | null, length: number }> =>
  await chrome.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#address') as HTMLInputElement
    return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length }
  })
const addressActive = async (chrome: Page): Promise<boolean> =>
  await chrome.evaluate(() => document.activeElement?.id === 'address')

/** The window holds the OS focus, with the keyboard in the page: the state a person is in when they press Ctrl+T. */
async function focusPageInWindow (app: ElectronApplication, chrome: Page, url: string): Promise<void> {
  await visit(app, chrome, url)
  await runCommand(chrome, 'nav.focusAddress')
  expect(await waitFor(async () => await focusedAt(app, CHROME))).toBe(true)
  await pressKey(app, CHROME, 'Escape')
  expect(await waitFor(async () => await focusedAt(app, url))).toBe(true)
  expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isFocused())).toBe(true)
}

async function expectBarHoldsKeyboard (app: ElectronApplication, chrome: Page): Promise<void> {
  expect(await waitFor(async () => await focusedAt(app, CHROME) && await addressActive(chrome))).toBe(true)
  // The dashboard takes the keyboard when its page commits: wait past it, then read once.
  expect(await waitFor(() => app.windows().some((page) => page.url().endsWith('/newtab/index.html')))).toBe(true)
  await delay(ABSENCE_SETTLE_MS)
  expect(await focusedAt(app, '/newtab/')).toBe(false)
  expect(await focusedAt(app, CHROME)).toBe(true)
  expect(await addressActive(chrome)).toBe(true)
}

it('starts a new tab with the keyboard in the address bar, not in the tab\'s own page', async () => {
  const { app, chrome } = await launchShell()
  try {
    await focusPageInWindow(app, chrome, `${server.origin}/one`)
    await runCommand(chrome, 'tab.new')
    await expectBarHoldsKeyboard(app, chrome)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('does the same for a tab the page of the chrome opens', async () => {
  const { app, chrome } = await launchShell()
  try {
    await focusPageInWindow(app, chrome, `${server.origin}/one`)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    await expectBarHoldsKeyboard(app, chrome)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('selects the whole address on the first click, places a caret on the second, and keeps what a first press dragged', async () => {
  const { app, chrome } = await launchShell()
  try {
    const one = `${server.origin}/one`
    await visit(app, chrome, one)
    await runCommand(chrome, 'nav.focusAddress')
    expect(await waitFor(async () => await focusedAt(app, CHROME))).toBe(true)
    await pressKey(app, CHROME, 'Escape')
    expect(await waitFor(async () => await focusedAt(app, one))).toBe(true)

    await chrome.click('#address')
    expect(await selection(chrome)).toMatchObject({ start: 0, end: one.length })
    await chrome.click('#address')
    const caret = await selection(chrome)
    expect(caret.start).toBe(caret.end)

    await pressKey(app, CHROME, 'Escape')
    expect(await waitFor(async () => await focusedAt(app, one))).toBe(true)
    const box = await chrome.locator('#address').boundingBox()
    if (box === null) throw new Error('the address field has no box')
    const y = box.y + box.height / 2
    await chrome.mouse.move(box.x + 24, y)
    await chrome.mouse.down()
    await chrome.mouse.move(box.x + 90, y, { steps: 6 })
    await chrome.mouse.up()
    const dragged = await selection(chrome)
    expect(dragged.start).not.toBeNull()
    expect((dragged.end ?? 0) - (dragged.start ?? 0)).toBeGreaterThan(0)
    expect((dragged.end ?? 0) - (dragged.start ?? 0)).toBeLessThan(one.length)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
