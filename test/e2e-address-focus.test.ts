// The address field and the keyboard. Enter and Escape hand the keyboard to the page, and a tab switch with the field
// focused shows the new tab's address, so Enter cannot load the old tab's address into it. An edit kept while the
// keyboard is in another app or the page is src/renderer/tests/navigation.test.ts's: the headless display delivers
// no blur to the chrome's document when a window or a sibling view takes the keyboard.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCommand } from './support/auth-support.js'
import { pressKey } from './support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './support/qa-helpers.js'
import { waitFor, waitForTab } from './support/smoke-helpers.mjs'

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
