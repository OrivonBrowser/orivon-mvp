// The toolbar's popups in the running shell: Escape closes the site card, the Web3 Score page and the all-sites
// list and hands the keyboard back so Ctrl+F still opens find; the key and the shield swap one popup for the other
// whichever order they are pressed in, including after the first popup already lost focus to the press. The all-sites
// popup reopens topmost, sized and painted after every way it can have left the window, among them an overlay or a tab
// switch closing it without a blur, and its page crashing or being destroyed while it shows.
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-toolbar-popups.test.ts
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from './support/launch-electron.mjs'
import { pressKey, waitForKeyboardAt } from './support/e2e-helpers.js'
import { distinctColours } from './support/qa-visual.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './support/qa-helpers.js'
import type { FixtureServer } from './support/qa-helpers.js'
import { delay, popoverShown, waitFor } from './support/smoke-helpers.mjs'

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
  expect(await waitForKeyboardAt(app, 'overlay=find')).toBe(true)
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
      expect(await waitForKeyboardAt(app, '/site-info/')).toBe(true)
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
    expect(await waitForKeyboardAt(app, '/permissions/')).toBe(true)
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
      expect(await waitForKeyboardAt(app, '/site-info/')).toBe(true)
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

/** What a reopened all-sites popup must be: the topmost child of its window, with a real size, painting more than one colour. */
async function expectPermissionsOnScreen (app: ElectronApplication, path: string): Promise<void> {
  const top = await app.evaluate(({ BaseWindow }) => {
    const view = BaseWindow.getAllWindows()[0]?.contentView.children.at(-1) as { webContents?: { getURL: () => string }, getBounds: () => { width: number, height: number } } | undefined
    return view === undefined ? null : { url: view.webContents?.getURL() ?? '', bounds: view.getBounds() }
  })
  expect({ path, topmost: top?.url.includes('/permissions/') }).toEqual({ path, topmost: true })
  expect(top?.bounds.width ?? 0).toBeGreaterThan(100)
  expect(top?.bounds.height ?? 0).toBeGreaterThan(100)
  const page = app.windows().find((w) => w.url().includes('/permissions/'))
  expect(page).toBeDefined()
  await page?.waitForSelector('#site-settings-link')
  expect({ path, colours: distinctColours(await (page as NonNullable<typeof page>).screenshot()) > 3 }).toEqual({ path, colours: true })
}

it('the all-sites popup reopens on screen after every way it can have been closed', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    const open = async (): Promise<void> => {
      // Past the debounce that reads a toggle just after a blur close as that close's echo.
      await delay(450)
      await chrome.locator('#permissions-btn').click()
      expect(await waitFor(async () => await permissionsShown(app))).toBe(true)
    }
    const closedBy: Record<string, () => Promise<void>> = {
      'the button again': async () => { await chrome.locator('#permissions-btn').click() },
      'a click into the page': async () => {
        await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getType() === 'window' && /\/newtab\/|127\.0\.0\.1/.test(wc.getURL()))?.focus() })
      },
      Escape: async () => {
        expect(await waitForKeyboardAt(app, '/permissions/')).toBe(true)
        await pressKey(app, '/permissions/', 'Escape')
      },
      'All site settings': async () => {
        await app.windows().find((w) => w.url().includes('/permissions/'))?.locator('#site-settings-link').click()
      },
      'the window losing focus': async () => {
        await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.blur() })
        await focusChrome(app)
      }
    }

    await open()
    await expectPermissionsOnScreen(app, 'first open')
    for (const [path, close] of Object.entries(closedBy)) {
      await close()
      expect({ path, closed: await waitFor(async () => !(await permissionsShown(app))) }).toEqual({ path, closed: true })
      await open()
      await expectPermissionsOnScreen(app, path)
    }
  } finally {
    await closeElectron(app)
  }
}, 90_000)

/** The all-sites popup's webContents id, or undefined while none exists. */
async function permissionsContentsId (app: ElectronApplication): Promise<number | undefined> {
  return await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('/permissions/'))?.id)
}

async function openPermissions (app: ElectronApplication, chrome: Page): Promise<void> {
  // Past the debounce that reads a toggle just after a blur close as that close's echo.
  await delay(450)
  await chrome.locator('#permissions-btn').click()
  expect(await waitFor(async () => await permissionsShown(app))).toBe(true)
}

it('the all-sites popup reopens on screen after another overlay, a tab switch or the site card took its place', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    const closedBy: Record<string, () => Promise<void>> = {
      // Pressed inside the popup, which holds the keyboard: the overlay host closes it, no blur first.
      'the find bar opening': async () => {
        expect(await waitForKeyboardAt(app, '/permissions/')).toBe(true)
        await pressKey(app, '/permissions/', 'F', ['control'])
        expect(await waitFor(async () => await findShown(app))).toBe(true)
        expect(await waitForKeyboardAt(app, 'overlay=find')).toBe(true)
        await pressKey(app, 'overlay=find', 'Escape')
        expect(await waitFor(async () => !(await findShown(app)))).toBe(true)
      },
      'a new tab': async () => {
        expect(await waitForKeyboardAt(app, '/permissions/')).toBe(true)
        await pressKey(app, '/permissions/', 'T', ['control'])
      },
      'a tab switch': async () => {
        expect(await waitForKeyboardAt(app, '/permissions/')).toBe(true)
        await pressKey(app, '/permissions/', 'Tab', ['control'])
      },
      'the site card opening': async () => {
        await chrome.locator('#site-permissions-btn').click()
        expect(await waitFor(async () => await siteInfoShown(app))).toBe(true)
        expect(await waitForKeyboardAt(app, '/site-info/')).toBe(true)
        await pressKey(app, '/site-info/', 'Escape')
        expect(await waitFor(async () => !(await siteInfoShown(app)))).toBe(true)
      },
      'a relayout': async () => {
        await app.evaluate(({ BaseWindow }) => {
          const win = BaseWindow.getAllWindows()[0]
          if (win === undefined) throw new Error('no window')
          const [width, height] = win.getSize()
          win.setSize((width ?? 1200) + 30, height ?? 800)
        })
      }
    }

    await openPermissions(app, chrome)
    for (const [path, close] of Object.entries(closedBy)) {
      await close()
      expect({ path, closed: await waitFor(async () => !(await permissionsShown(app))) }).toEqual({ path, closed: true })
      await openPermissions(app, chrome)
      await expectPermissionsOnScreen(app, path)
    }
  } finally {
    await closeElectron(app)
  }
}, 120_000)

it('the all-sites popup reopens on screen after its renderer crashed or its contents were destroyed while it showed', async () => {
  const { app, chrome } = await launchShell()
  try {
    await ready(app, chrome)
    const brokenBy: Record<string, () => Promise<void>> = {
      'the renderer crashing': async () => {
        await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getURL().includes('/permissions/'))?.forcefullyCrashRenderer() })
      },
      'the contents being destroyed': async () => {
        await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getURL().includes('/permissions/'))?.close({ waitForBeforeUnload: false }) })
      }
    }
    for (const [path, breakIt] of Object.entries(brokenBy)) {
      await openPermissions(app, chrome)
      await expectPermissionsOnScreen(app, `${path}: first open`)
      const before = await permissionsContentsId(app)
      await breakIt()
      // A popup that lost its page takes itself off the window, so the person's next click opens a new one.
      expect({ path, closed: await waitFor(async () => !(await permissionsShown(app))) }).toEqual({ path, closed: true })
      await openPermissions(app, chrome)
      await expectPermissionsOnScreen(app, path)
      expect({ path, rebuilt: (await permissionsContentsId(app)) !== before }).toEqual({ path, rebuilt: true })
      expect(await waitForKeyboardAt(app, '/permissions/')).toBe(true)
      await pressKey(app, '/permissions/', 'Escape')
      expect(await waitFor(async () => !(await permissionsShown(app)))).toBe(true)
    }
  } finally {
    await closeElectron(app)
  }
}, 120_000)
