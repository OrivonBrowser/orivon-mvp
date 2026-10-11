// Home and where a window opens: the Home button and page, the window's place
// restored (and never a place no display shows), addresses given on the command
// line, keep-on-top, a private session that records nothing, and a kiosk.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots of the new surfaces.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { bindingOf, pressCommand, shownBinding } from '../support/e2e-helpers.js'
import { closeElectron, assertNoElectronSurvivors, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, evaluateRetrying, findViewShowing, popoverShown, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']
const TEST_TIMEOUT_MS = 90_000
// The container width (toolbar.css) at and below which pinned extension buttons give way to the Extensions button.
const PINNED_BUTTONS_WIDTH = 540

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((request, response) => {
    const name = (request.url ?? '/').replace(/^\//, '') || 'root'
    html(response, `<!doctype html><meta charset="utf-8"><title>Page ${name}</title><body style="font:16px sans-serif;margin:32px"><h1>Page ${name}</h1><p><a id="link" href="/elsewhere">A link</a></p>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const settingsJson = (values: Record<string, unknown>) => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values }))
}

const stateJson = (bounds: { x: number, y: number, width: number, height: number }, maximized = false) => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'window-state.json'), JSON.stringify({ version: 1, bounds, maximized }))
}

const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))
const firstWindowBounds = async (app: ElectronApplication): Promise<{ x: number, y: number, width: number, height: number }> =>
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 })
/** Resizes once the window is on screen: the size a window is shown at is asserted as it appears, and would override an earlier one. */
const resizeShown = async (app: ElectronApplication, bounds: { x: number, y: number, width: number, height: number }): Promise<void> => {
  expect(await waitFor(async () => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isVisible() === true))).toBe(true)
  await app.evaluate(({ BaseWindow }, next) => { BaseWindow.getAllWindows()[0]?.setBounds(next) }, bounds)
}
const primaryDisplay = async (app: ElectronApplication): Promise<{ width: number, height: number }> =>
  await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds)
const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}
const homeShown = async (chrome: Page): Promise<boolean> => await evaluateRetrying(chrome, () => {
  const button = document.querySelector<HTMLElement>('#home')
  return button !== null && !button.hidden && button.getBoundingClientRect().width > 0
})
const activeAddress = async (chrome: Page): Promise<string> => String((await activeTabInfo(chrome)).address)
async function shoot (page: Page, name: string, scheme: 'light' | 'dark'): Promise<void> {
  if (SHOTS_DIR === undefined) return
  await mkdir(SHOTS_DIR, { recursive: true })
  await page.emulateMedia({ colorScheme: scheme })
  await delay(250)
  await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  await page.emulateMedia({ colorScheme: null })
}

it('shows the Home button when asked, loads the home page in this tab, and opens it in a new tab for a middle or Mod click', async () => {
  const home = `${server.origin}/home`
  const { app, chrome } = await launchShell({ seedProfile: settingsJson({ 'home.url': home, 'toolbar.home': true }) })
  try {
    expect(await waitFor(async () => await homeShown(chrome))).toBe(true)
    expect(await chrome.getAttribute('#home', 'aria-label')).toBe('Home')
    expect(await chrome.getAttribute('#home', 'title')).toBe(`Home (${shownBinding(bindingOf('nav.home'))})`)
    // Right of Reload, before the bookmark star.
    const box = async (selector: string): Promise<number> => (await chrome.locator(selector).boundingBox())?.x ?? -1
    expect(await box('#home')).toBeGreaterThan(await box('#reload'))
    expect(await box('#home')).toBeLessThan(await box('#bookmark-toggle'))

    await shoot(chrome, 'toolbar-home', 'light')
    await shoot(chrome, 'toolbar-home', 'dark')
    await chrome.locator('#home').hover()
    await shoot(chrome, 'toolbar-home-hover', 'dark')
    await chrome.mouse.move(600, 300)

    await visit(app, chrome, `${server.origin}/a`)
    await chrome.click('#home')
    expect((await waitForTab(chrome, { address: home })).ok).toBe(true)
    expect(await tabIds(chrome)).toHaveLength(1)

    await visit(app, chrome, `${server.origin}/a`)
    await pressCommand(app, '/a', 'nav.home')
    expect((await waitForTab(chrome, { address: home })).ok).toBe(true)
    expect(await tabIds(chrome)).toHaveLength(1)

    // A middle click and a Mod click each open the home page in a background tab.
    await visit(app, chrome, `${server.origin}/a`)
    const [current] = await tabIds(chrome)
    await chrome.click('#home', { button: 'middle' })
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    await chrome.click('#home', { modifiers: ['ControlOrMeta'] })
    expect(await waitFor(async () => (await tabIds(chrome)).length === 3)).toBe(true)
    expect((await activeTabInfo(chrome)).activeId).toBe(current)
    expect(await activeAddress(chrome)).toBe(`${server.origin}/a`)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('turns the Home button on and off from Settings with no restart, and refuses a home page that is not an address', async () => {
  const { app, chrome } = await launchShell({ seedProfile: settingsJson({ 'home.url': `${server.origin}/home`, 'toolbar.home': true }) })
  try {
    expect(await waitFor(async () => await homeShown(chrome))).toBe(true)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/startup') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-home-url input.text')
    expect(await settings.inputValue('#row-home-url input.text')).toBe(`${server.origin}/home`)
    expect(await settings.getAttribute('#row-home-url input.text', 'placeholder')).toBe('New tab page')

    await shoot(settings, 'settings-home', 'light')
    await shoot(settings, 'settings-home', 'dark')

    await settings.fill('#row-home-url input.text', 'two words, not an address')
    await settings.press('#row-home-url input.text', 'Enter')
    await settings.waitForFunction(() => (document.querySelector('#row-home-url .problem')?.textContent ?? '') !== '')
    expect(await settings.textContent('#row-home-url .problem')).toBe('Enter a web address, like https://example.com')
    await shoot(settings, 'settings-home-invalid', 'dark')
    await shoot(settings, 'settings-home-invalid', 'light')

    await settings.fill('#row-home-url input.text', 'example.com')
    await settings.press('#row-home-url input.text', 'Enter')
    await settings.waitForFunction(() => document.querySelector('#row-home-url .changed') !== null)
    expect(await settings.textContent('#row-home-url .problem')).toBe('')

    await settings.click('#row-home-button input')
    expect(await waitFor(async () => !(await homeShown(chrome)))).toBe(true)
    await settings.click('#row-home-button input')
    expect(await waitFor(async () => await homeShown(chrome))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('with no home page, Home opens the new tab page and never swaps a loaded page for it', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${server.origin}/a`)
    await runCommand(chrome, 'nav.home')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    // Settled on the page: until its address commits, a tab that is about to show it has no address at all.
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes('/newtab/'))))).toBe(true)
    expect(await activeAddress(chrome)).toBe('')

    await runCommand(chrome, 'nav.home')
    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(chrome)).toHaveLength(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

const MIN_WIDTH = 500

const setWidth = async (app: ElectronApplication, chrome: Page, width: number): Promise<void> => {
  await app.evaluate(({ BaseWindow }, w) => { BaseWindow.getAllWindows()[0]?.setSize(w, 400) }, width)
  // The chrome view takes the new width a moment after the window does.
  expect(await waitFor(async () => (await chrome.evaluate(() => window.innerWidth)) === width)).toBe(true)
}

const addActionButtons = (chrome: Page, count: number): Promise<boolean> => chrome.evaluate((n) => {
  const root = document.querySelector('browser-action-list')?.shadowRoot
  if (root === null || root === undefined) return false
  for (let i = 0; i < n; i += 1) {
    const node = document.createElement('button')
    node.className = 'action'
    ;(node as unknown as { part: string }).part = 'action'
    root.appendChild(node)
  }
  return true
}, count)

const toolbarRow = (chrome: Page) => chrome.evaluate(() => {
  const list = document.querySelector('browser-action-list')
  const root = list?.shadowRoot
  const box = list?.getBoundingClientRect()
  return {
    listShown: list !== null && getComputedStyle(list).display !== 'none',
    listRight: box?.right ?? 0,
    widths: [...(root?.querySelectorAll('.action') ?? [])].map((node) => node.getBoundingClientRect().width),
    rights: [...(root?.querySelectorAll('.action') ?? [])].map((node) => node.getBoundingClientRect().right),
    extensionsButton: (document.querySelector<HTMLElement>('#extensions-menu-btn')?.getBoundingClientRect().width ?? 0) > 0,
    field: document.querySelector<HTMLInputElement>('#address')?.getBoundingClientRect().width ?? 0
  }
})

it('stops the window at its minimum size, and the address field still has room there', async () => {
  const { app, chrome } = await launchShell({ seedProfile: settingsJson({ 'toolbar.home': true, 'toolbar.extensions': 'never' }) })
  try {
    expect(await waitFor(async () => await homeShown(chrome))).toBe(true)
    expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getMinimumSize())).toEqual([MIN_WIDTH, 400])
    expect(await waitFor(async () => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isVisible() === true))).toBe(true)
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(300, 200) })
    expect(await waitFor(async () => (await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getSize())) !== undefined)).toBe(true)
    const size = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getSize() ?? [0, 0])
    expect(size[0]).toBeGreaterThanOrEqual(MIN_WIDTH)
    expect(size[1]).toBeGreaterThanOrEqual(400)
    // The chrome view takes the new width a moment after the window does.
    expect(await waitFor(async () => (await chrome.evaluate(() => window.innerWidth)) <= 520)).toBe(true)
    const field = await chrome.evaluate(() => document.querySelector<HTMLInputElement>('#address')?.getBoundingClientRect().width ?? 0)
    expect(field).toBeGreaterThanOrEqual(120)

    // Four extension buttons (the library's own element and class, built by hand since no extension is
    // installed): the list shows one whole button and clips the rest, instead of squeezing all four.
    expect(await addActionButtons(chrome, 4)).toBe(true)
    const buttons = await toolbarRow(chrome)
    expect(buttons.widths).toEqual([32, 32, 32, 32])
    expect(buttons.rights[0] ?? 1e9).toBeLessThanOrEqual(buttons.listRight + 0.5)
    expect(buttons.rights[1] ?? 0).toBeGreaterThan(buttons.listRight + 0.5)
    expect(buttons.field).toBeGreaterThanOrEqual(96)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('with the Extensions button shown, the pinned buttons wait in its menu at the minimum size, and the address field keeps its room', async () => {
  const { app, chrome } = await launchShell({ seedProfile: settingsJson({ 'toolbar.home': true }) })
  try {
    expect(await waitFor(async () => await homeShown(chrome))).toBe(true)
    expect(await waitFor(async () => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isVisible() === true))).toBe(true)
    await setWidth(app, chrome, MIN_WIDTH)
    const atMinimum = await toolbarRow(chrome)
    expect(atMinimum.extensionsButton).toBe(true)
    expect(atMinimum.field).toBeGreaterThanOrEqual(96)

    expect(await addActionButtons(chrome, 4)).toBe(true)
    const crowded = await toolbarRow(chrome)
    expect(crowded.listShown).toBe(false)
    expect(crowded.extensionsButton).toBe(true)
    expect(crowded.field).toBeGreaterThanOrEqual(96)

    // Just above the width where the list gives way, one whole pinned button is back and the field still has room.
    await setWidth(app, chrome, PINNED_BUTTONS_WIDTH + 10)
    const roomy = await toolbarRow(chrome)
    expect(roomy.listShown).toBe(true)
    expect(roomy.widths).toEqual([32, 32, 32, 32])
    expect(roomy.rights[0] ?? 1e9).toBeLessThanOrEqual(roomy.listRight + 0.5)
    expect(roomy.rights[1] ?? 0).toBeGreaterThan(roomy.listRight + 0.5)
    expect(roomy.field).toBeGreaterThanOrEqual(96)

    // At the width itself the list is already gone.
    await setWidth(app, chrome, PINNED_BUTTONS_WIDTH)
    expect((await toolbarRow(chrome)).listShown).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens the window at the place it was left, and never at one no display shows', async () => {
  const saved = await launchShell({ seedProfile: stateJson({ x: 60, y: 40, width: 900, height: 620 }) })
  try {
    expect(await waitFor(async () => (await firstWindowBounds(saved.app)).width === 900)).toBe(true)
    expect((await firstWindowBounds(saved.app)).height).toBe(620)
  } finally {
    await closeElectron(saved.app)
  }

  const gone = await launchShell({ seedProfile: stateJson({ x: 50_000, y: 40, width: 900, height: 620 }) })
  try {
    const display = await primaryDisplay(gone.app)
    const expected = { width: Math.min(1280, display.width), height: Math.min(800, display.height) }
    expect(await waitFor(async () => (await firstWindowBounds(gone.app)).width === expected.width)).toBe(true)
    expect((await firstWindowBounds(gone.app)).height).toBe(expected.height)
  } finally {
    await closeElectron(gone.app)
  }
}, TEST_TIMEOUT_MS)

it('writes the place it is moved to, and the next launch opens there', async () => {
  const first = await launchShell()
  const dir = await userDataOf(first.app)
  try {
    await resizeShown(first.app, { x: 40, y: 30, width: 860, height: 560 })
    const file = join(dir, 'window-state.json')
    const written = async (): Promise<number> => {
      try { return (JSON.parse(await readFile(file, 'utf8')) as { bounds: { width: number } }).bounds.width } catch { return 0 }
    }
    expect(await waitFor(async () => await written() === 860)).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, bounds: { width: 860, height: 560 }, maximized: false })
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }

  const second = await launchShell({ reuseProfile: dir })
  try {
    expect(await waitFor(async () => (await firstWindowBounds(second.app)).width === 860)).toBe(true)
    expect((await firstWindowBounds(second.app)).height).toBe(560)
  } finally {
    await closeElectron(second.app)
  }
}, TEST_TIMEOUT_MS)

it('opens the web addresses and local files it is started with as tabs, in order, the first in front, and nothing else', async () => {
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'orivon-start-file-'))
  const local = join(folder, 'local.html')
  await writeFile(local, '<!doctype html><title>Local c</title><p>c</p>')
  const operands = [`${server.origin}/a`, pathToFileURL(local).href, 'javascript:alert(1)', `${server.origin}/b`, 'file://nas/share/x.html']
  // Electron on Windows exits before any script runs when a URL is followed by another operand with no `--` first, its
  // guard against arguments smuggled through a protocol link; src/main/launch/launch-request.ts reads past the `--`.
  const { app, chrome } = await launchShell({ args: process.platform === 'win32' ? ['--', ...operands] : operands })
  try {
    expect(await waitFor(async () => (await tabIds(chrome)).length === 3)).toBe(true)
    expect((await waitForTab(chrome, { address: `${server.origin}/a` })).ok).toBe(true)
    const titles = async (): Promise<string[]> => await evaluateRetrying(chrome, () => Array.from(document.querySelectorAll('.tab .title')).map((el) => el.textContent ?? ''))
    expect(await waitFor(async () => (await titles()).join() === 'Page a,Local c,Page b')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
    await rm(folder, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('opens a given address under the welcome screen on a first run', async () => {
  const { app, chrome } = await launchShell({ env: { ORIVON_INTRO: 'always' }, args: [`${server.origin}/a`], chrome: false })
  try {
    expect((await waitForTab(chrome, { address: `${server.origin}/a` })).ok).toBe(true)
    expect(await tabIds(chrome)).toHaveLength(1)
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes('intro'))))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps the window on top for the window that asked, and lets it go again', async () => {
  const { app, chrome } = await launchShell()
  try {
    const onTop = async (): Promise<boolean | undefined> => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isAlwaysOnTop())
    expect(await onTop()).toBe(false)
    await runCommand(chrome, 'window.alwaysOnTop')
    expect(await waitFor(async () => await onTop() === true)).toBe(true)
    await runCommand(chrome, 'window.alwaysOnTop')
    expect(await waitFor(async () => await onTop() === false)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a private session opens a given address, keeps the Home button, and records no window place', async () => {
  const home = `${server.origin}/home`
  const { app, chrome } = await launchShell({ args: ['--orivon-private', `${server.origin}/a`], seedProfile: settingsJson({ 'home.url': home, 'toolbar.home': true }) })
  const dir = await userDataOf(app)
  try {
    expect((await waitForTab(chrome, { address: `${server.origin}/a` })).ok).toBe(true)
    expect(await waitFor(async () => await homeShown(chrome))).toBe(true)
    await shoot(chrome, 'toolbar-home-private', 'light')
    await shoot(chrome, 'toolbar-home-private', 'dark')
    await chrome.click('#home')
    expect((await waitForTab(chrome, { address: home })).ok).toBe(true)

    await resizeShown(app, { x: 40, y: 30, width: 860, height: 560 })
    await delay(ABSENCE_SETTLE_MS + 500)
    expect(existsSync(join(dir, 'window-state.json'))).toBe(false)
  } finally {
    await closeElectron(app)
    await rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('a kiosk fills the screen with the given address, no chrome, and runs only what a kiosk allows', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-kiosk', `${server.origin}/a`] })
  try {
    expect((await waitForTab(chrome, { address: `${server.origin}/a` })).ok).toBe(true)
    const layout = await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0]
      const views = (win?.contentView.children ?? []).map((view) => ({ visible: view.getVisible(), y: view.getBounds().y, height: view.getBounds().height }))
      return { kiosk: win?.isKiosk(), views }
    })
    expect(layout.kiosk).toBe(true)
    // The chrome is hidden and the page starts at the top of the window.
    expect(layout.views.filter((view) => view.visible).every((view) => view.y === 0)).toBe(true)
    expect(layout.views.some((view) => !view.visible)).toBe(true)

    await pressCommand(app, '/a', 'tab.new')
    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(chrome)).toHaveLength(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

const crashedSession = JSON.stringify({ version: 1, clean: false, windows: [{ bounds: { x: 20, y: 20, width: 900, height: 600 }, maximized: false, active: 0, tabs: [{ url: 'https://saved.example/', title: 'Saved', pinned: false }] }] })

it('a kiosk leaves the saved session alone and offers none back, even after a crash', async () => {
  const { app, chrome } = await launchShell({
    args: ['--orivon-kiosk', `${server.origin}/a`],
    seedProfile: async (dir) => {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.json'), crashedSession)
    }
  })
  let dir = ''
  try {
    expect((await waitForTab(chrome, { address: `${server.origin}/a` })).ok).toBe(true)
    dir = await userDataOf(app)
    // Past the moment the offer would appear, and the recorder's first write.
    await delay(ABSENCE_SETTLE_MS + 1500)
    expect(await popoverShown(app, 'overlay=restore')).toBe(false)
    expect(app.windows().some((w) => w.url().includes('overlay=restore'))).toBe(false)
  } finally {
    // Kept so the file can be read once the app has quit, which is when a session would be written.
    await closeElectron(app, { keepProfile: true })
  }
  try {
    expect(await readFile(join(dir, 'session.json'), 'utf8')).toBe(crashedSession)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('a kiosk\'s link menu offers no other tab, window or private session', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-kiosk', `${server.origin}/a`] })
  try {
    expect((await waitForTab(chrome, { address: `${server.origin}/a` })).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, `${server.origin}/a`) !== undefined)).toBe(true)
    const page = findViewShowing(app, chrome, `${server.origin}/a`) as Page
    await page.waitForSelector('#link')
    await app.evaluate(({ Menu }) => {
      Menu.prototype.popup = function () { (globalThis as { __menu?: unknown }).__menu = this }
    })
    await page.click('#link', { button: 'right' })
    expect(await waitFor(async () => await app.evaluate(() => (globalThis as { __menu?: unknown }).__menu !== undefined))).toBe(true)
    const labels = await app.evaluate(() => ((globalThis as { __menu?: { items: Array<{ label: string }> } }).__menu?.items ?? []).map((item) => item.label))
    expect(labels).toContain('Copy Link Address')
    expect(labels.filter((label) => label.startsWith('Open '))).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
