// The welcome screen (src/main/shell/intro-view.ts, src/renderer/intro/), on a
// real launch: when it shows, that it covers the window and stays on top, that
// "Enter Orivon" reveals the dashboard, and that only `once` remembers the
// click. launch-electron.mjs turns it off by default, so every other suite
// keeps its two-window launch; each test here asks for a mode explicitly.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { readFocusLog, startFocusLog } from '../support/focus-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 45_000

function launch (mode: string, seed?: (dir: string) => Promise<void>, env: Record<string, string> = {}): Promise<ElectronApplication> {
  return launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_INTRO: mode, ...env },
    ...(seed === undefined ? {} : { seedProfile: seed })
  })
}

const introPage = (app: ElectronApplication): Page | undefined =>
  app.windows().find((w) => w.url().includes('/intro/index.html'))
const dashboardPage = (app: ElectronApplication): Page | undefined =>
  app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

/** Chrome view, dashboard tab and (when showing) the intro: the same count the other suites wait on, plus one. */
const windowCount = (app: ElectronApplication): number => app.windows().length

const userDataDir = (app: ElectronApplication): Promise<string> => app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

async function untilShell (app: ElectronApplication): Promise<void> {
  expect(await waitFor(() => dashboardPage(app) !== undefined)).toBe(true)
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
}

it('once, on a fresh profile: shows over the whole window, stays on top of a new tab, and Enter reveals the dashboard and is remembered', async () => {
  const app = await launch('once')
  try {
    expect(await waitFor(() => introPage(app) !== undefined && windowCount(app) === 3)).toBe(true)
    const intro = introPage(app)
    if (intro === undefined) throw new Error('unreachable: waited for it above')

    expect(await intro.getAttribute('h1.headline', 'aria-label')).toBe('The browser Web3 deserves.')
    expect(await intro.textContent('#enter')).toContain('Enter Orivon')
    const content = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getContentBounds())
    expect(await intro.evaluate(() => [innerWidth, innerHeight])).toEqual([content?.width, content?.height])

    // The keyboard is the welcome screen's in the main process, not only in its document: the dashboard's search box under it does not hold it.
    const focusedUrls = (): Promise<string[]> => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().filter((wc) => wc.isFocused()).map((wc) => wc.getURL()))
    expect(await waitFor(async () => (await focusedUrls()).some((url) => url.includes('/intro/index.html')))).toBe(true)
    expect((await focusedUrls()).some((url) => url.includes('/newtab/'))).toBe(false)

    // A new tab re-adds its view to the window, which would bury the intro
    // without keepOnTop; it must still be the topmost view afterwards.
    await findChrome(app).evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    expect(await waitFor(() => windowCount(app) === 4)).toBe(true)
    const topmost = await app.evaluate(({ BaseWindow }) => {
      const last = BaseWindow.getAllWindows()[0]?.contentView.children.at(-1) as unknown as { webContents: Electron.WebContents }
      return last.webContents.getURL()
    })
    expect(topmost).toContain('/intro/index.html')

    // The screen takes the keyboard on its own: Enter alone leaves it, no Tab first.
    expect(await waitFor(async () => (await intro.evaluate(() => document.activeElement?.id)) === 'enter')).toBe(true)
    await intro.keyboard.press('Enter')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 3)).toBe(true)

    // Entering gives the keyboard to the address bar: the new tab in front is a start page, and the bar is where a person types.
    const chrome = findChrome(app)
    const barActive = (): Promise<boolean> => chrome.evaluate(() => document.activeElement?.id === 'address')
    expect(await waitFor(async () => (await focusedUrls()).some((url) => url.includes('/renderer/index.html')) && await barActive())).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect((await focusedUrls()).some((url) => url.includes('/newtab/'))).toBe(false)
    expect(await barActive()).toBe(true)

    const dashboard = dashboardPage(app)
    if (dashboard === undefined) throw new Error('the dashboard tab is gone')
    // The background picture is a real, decodable file at the built path.
    const decoded = await dashboard.evaluate(async () => {
      const url = /url\("?([^")]+)"?\)/.exec(getComputedStyle(document.documentElement).backgroundImage)?.[1]
      if (url === undefined) return 'no background-image url'
      const image = new Image()
      image.src = url
      await image.decode()
      return image.naturalWidth
    })
    expect(decoded).toBe(2398)

    const seenFile = join(await userDataDir(app), 'intro.json')
    expect(await waitFor(() => existsSync(seenFile))).toBe(true)
    expect(JSON.parse(await readFile(seenFile, 'utf8'))).toEqual({ seen: true })

    // The first letter typed builds the dropdown, and its page does not take the keyboard from the field.
    await startFocusLog(app)
    await chrome.keyboard.type('a', { delay: 25 })
    expect(await waitFor(() => popoverShown(app, 'overlay=omnibox'))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    const taken = await readFocusLog(app)
    expect(taken.filter((url) => url === 'blank' || url.includes('overlay=omnibox'))).toEqual([])
    expect((await focusedUrls()).some((url) => url.includes('/renderer/index.html'))).toBe(true)
    expect(await barActive()).toBe(true)
  } finally {
    // Two tabs are open here, and closing the app under them throws in main (A259).
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('once, on a profile that has already seen it: opens straight on the dashboard', async () => {
  const app = await launch('once', (dir) => writeFile(join(dir, 'intro.json'), '{"seen":true}', 'utf8'))
  try {
    await untilShell(app)
    // Absence cannot be polled for: wait out the time the view would have taken.
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeUndefined()
    expect(windowCount(app)).toBe(2)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('always: shows even when seen, and clicking through does not use up the one-time showing', async () => {
  const app = await launch('always', (dir) => writeFile(join(dir, 'intro.json'), '{"seen":true}', 'utf8'))
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    await introPage(app)?.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
  } finally {
    await closeElectron(app)
  }

  const fresh = await launch('always')
  try {
    expect(await waitFor(() => introPage(fresh) !== undefined)).toBe(true)
    await introPage(fresh)?.click('#enter')
    expect(await waitFor(() => introPage(fresh) === undefined && windowCount(fresh) === 2)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(existsSync(join(await userDataDir(fresh), 'intro.json'))).toBe(false)
  } finally {
    await closeElectron(fresh)
  }
}, TEST_TIMEOUT_MS * 2)

const seamCalls = (app: ElectronApplication): Promise<{ setDefault: string[] }> =>
  app.evaluate(() => (globalThis as unknown as { __orivonDevDefaultBrowser: { setDefault: string[] } }).__orivonDevDefaultBrowser)

it('offers no default-browser box on a run that cannot register, and registers nothing', async () => {
  const app = await launch('always')
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    expect(await intro.locator('#default-offer').isHidden()).toBe(true)
    await intro.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers an unticked default-browser box where it can register, and Enter without the tick registers nothing', async () => {
  const app = await launch('always', undefined, { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' })
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    expect(await intro.locator('#default-offer').isVisible()).toBe(true)
    expect(await intro.locator('#make-default').isChecked()).toBe(false)
    expect((await intro.locator('#default-offer').innerText()).trim()).toBe('Make Orivon my default browser')
    await intro.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect((await seamCalls(app)).setDefault).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('registers http and https when the box is ticked and Enter Orivon is pressed', async () => {
  const app = await launch('always', undefined, { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' })
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    await intro.check('#make-default')
    await intro.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined)).toBe(true)
    expect(await waitFor(async () => (await seamCalls(app)).setDefault.length === 2, 10_000)).toBe(true)
    expect((await seamCalls(app)).setDefault).toEqual(['http', 'https'])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the default test launch opens without it', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await untilShell(app)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeUndefined()
    expect(windowCount(app)).toBe(2)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
