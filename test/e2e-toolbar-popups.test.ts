// The toolbar's popups in the running shell: Escape closes the site card, the Web3 Score page and the all-sites
// list and hands the keyboard back so Ctrl+F still opens find; the key and the shield swap one popup for the other
// whichever order they are pressed in, including after the first popup already lost focus to the press.
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-toolbar-popups.test.ts
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { delay, popoverShown, waitFor } from './smoke-helpers.mjs'

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((_request, response) => { html(response, '<!doctype html><title>plain</title><body>plain page</body>') })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const siteInfoShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, '/site-info/')
const permissionsShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, '/permissions/')
const findShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=find')

/** The tab at `urlPart` holds the keyboard. */
async function tabFocused (app: ElectronApplication, urlPart: string): Promise<boolean> {
  return await app.evaluate(({ webContents }, part) => webContents.getAllWebContents().find((wc) => wc.getURL().includes(part))?.isFocused() === true, urlPart)
}

/** Moves the keyboard to the chrome view the way a press on a toolbar button does, which blurs a popup that held it. */
async function focusChrome (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html'))?.focus() })
}

async function ready (app: ElectronApplication, chrome: Page): Promise<void> {
  await visit(app, chrome, `${server.origin}/`)
  expect(await waitFor(async () => await chrome.locator('#site-permissions-btn').isVisible() && await chrome.locator('#web3-score-btn').isVisible())).toBe(true)
}

/** Which of the popup's pages shows, by the element each one lives in. */
async function shownPage (app: ElectronApplication): Promise<string | undefined> {
  const popup = app.windows().find((w) => w.url().includes('/site-info/'))
  if (popup === undefined) return undefined
  return await popup.evaluate(() => (['main', 'web3', 'data'] as const).find((name) => {
    const el = document.querySelector<HTMLElement>(`#${name}-page`)
    return el !== null && !el.hidden && getComputedStyle(el).display !== 'none'
  }))
}

async function expectFindOpensOnTheTab (app: ElectronApplication): Promise<void> {
  expect(await waitFor(async () => await tabFocused(app, server.origin))).toBe(true)
  await pressKey(app, server.origin, 'F', ['control'])
  expect(await waitFor(async () => await findShown(app))).toBe(true)
  await pressKey(app, 'overlay=find', 'Escape')
  expect(await waitFor(async () => !(await findShown(app)))).toBe(true)
}

it('Escape closes the key popup and the shield popup, and Ctrl+F then opens find in the page', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    for (const button of ['#site-permissions-btn', '#web3-score-btn']) {
      await chrome.locator(button).click()
      expect(await waitFor(async () => await siteInfoShown(app))).toBe(true)
      expect(await waitFor(async () => (await shownPage(app)) !== undefined)).toBe(true)
      await pressKey(app, '/site-info/', 'Escape')
      expect(await waitFor(async () => !(await siteInfoShown(app)))).toBe(true)
      await expectFindOpensOnTheTab(app)
      await delay(400)
    }
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('Escape closes the all-sites popup and gives the keyboard back to the page', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    await chrome.locator('#permissions-btn').click()
    expect(await waitFor(async () => await permissionsShown(app))).toBe(true)
    await pressKey(app, '/permissions/', 'Escape')
    expect(await waitFor(async () => !(await permissionsShown(app)))).toBe(true)
    await expectFindOpensOnTheTab(app)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('a popup closed by the window resizing hands the keyboard back, so Ctrl+F still opens find', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    await chrome.locator('#site-permissions-btn').click()
    expect(await waitFor(async () => await siteInfoShown(app))).toBe(true)
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('/site-info/'))?.isFocused() === true))).toBe(true)
    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0]
      if (win === undefined) throw new Error('no window')
      const [width, height] = win.getSize()
      win.setSize((width ?? 1200) - 40, height ?? 800)
    })
    expect(await waitFor(async () => !(await siteInfoShown(app)))).toBe(true)
    await expectFindOpensOnTheTab(app)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('the other icon swaps the popup, after the first lost focus to the press and while it still holds it', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    const open = async (button: string, page: string): Promise<void> => {
      await chrome.locator(button).click()
      expect(await waitFor(async () => (await shownPage(app)) === page)).toBe(true)
    }
    const closeAll = async (): Promise<void> => {
      await pressKey(app, '/site-info/', 'Escape')
      expect(await waitFor(async () => !(await siteInfoShown(app)))).toBe(true)
      await delay(400)
    }

    // The press takes the keyboard first, so the popup has closed itself by the time the click reaches main.
    await open('#web3-score-btn', 'web3')
    await focusChrome(app)
    expect(await waitFor(async () => !(await siteInfoShown(app)))).toBe(true)
    await open('#site-permissions-btn', 'main')
    await closeAll()

    await open('#site-permissions-btn', 'main')
    await focusChrome(app)
    expect(await waitFor(async () => !(await siteInfoShown(app)))).toBe(true)
    await open('#web3-score-btn', 'web3')
    await closeAll()

    // No press in between: the popup is still showing when the other icon asks.
    await open('#web3-score-btn', 'web3')
    await open('#site-permissions-btn', 'main')
    await open('#web3-score-btn', 'web3')

    // The same icon twice still closes it, and does not reopen it.
    await chrome.locator('#web3-score-btn').click()
    await delay(600)
    expect(await siteInfoShown(app)).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
