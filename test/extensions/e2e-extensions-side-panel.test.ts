// An extension's side panel end to end (chrome.sidePanel): the picker lists the extension and shows its page in
// the panel's body; the page sees its own window; links leave it as tabs; the toolbar button and the extension's
// key open and close it; `open()` needs a gesture and a window with room; a tab can have a panel of its own or
// none; the page's `window.close()` closes the panel; disabling the extension takes it away.
//
// Fixture: test/apps/extensions/side-panel/. Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-side-panel.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, pressKey, runPhase } from '../support/e2e-helpers.js'
import { answeringWith, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import { FIXTURES_DIR } from '../support/extensions-fixtures.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 300_000
const NAME = 'Orivon E2E Side Panel'
const SHOTS = process.env['ORIVON_SHOTS_DIR']
const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function fixtureServer (): Promise<string> {
  const created = createServer((request, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<title>side-panel-fixture ${request.url ?? ''}</title><body>page</body>`)
  })
  servers.push(created)
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}/`
}

interface Rect { x: number, y: number, width: number, height: number }
type Host = Record<string, (...args: unknown[]) => unknown>
interface Seam { host: (index: number) => Host }

/** Calls `method` on the first window's panel, in main. */
async function panel<T = unknown> (app: ElectronApplication, method: string, ...args: unknown[]): Promise<T> {
  return await app.evaluate((_electron, [name, rest]: [string, unknown[]]) => {
    const seam = (globalThis as unknown as { __orivonDevSidePanel: Seam }).__orivonDevSidePanel
    return seam.host(0)[name]?.(...rest)
  }, [method, args] as [string, unknown[]]) as T
}

const pageOf = (app: ElectronApplication, id: string, file: string): Page | undefined =>
  app.windows().find((w) => w.url().startsWith(`chrome-extension://${id}/${file}`))
const overlayOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=side-panel'))

/** The bounds of the view in the shell window whose address starts with `part`, read in main. */
async function viewBounds (app: ElectronApplication, part: string): Promise<Rect | null> {
  return await app.evaluate(({ BaseWindow }, wanted: string) => {
    const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.some((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().endsWith('/renderer/index.html') === true))
    const found = win?.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().startsWith(wanted) === true)
    return found === undefined ? null : found.getBounds()
  }, part)
}

/** With ORIVON_SHOTS_DIR set, photographs `page` in both colour schemes. */
async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(350)
    await page.screenshot({ path: join(SHOTS, `side-panel-${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

async function windowId (app: ElectronApplication): Promise<number> {
  return await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.contentView.children.some((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().endsWith('/renderer/index.html') === true))?.id ?? -1)
}

async function resize (app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BaseWindow }, [w, h]: [number, number]) => {
    BaseWindow.getAllWindows().find((win) => win.contentView.children.some((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().endsWith('/renderer/index.html') === true))?.setSize(w, h)
  }, [width, height] as [number, number])
}

async function openExtensionsPage (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('extensions.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://extensions')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://extensions')) as Page
  await page.waitForSelector('.ext-list')
  return page
}

it('shows, drives and closes an extension\'s side panel the way the extension asks', async () => {
  const fixtureUrl = await fixtureServer()
  await runPhase('extension side panel', async (record) => {
    const check = (name: string, pass: boolean, detail?: string): void => {
      console.log(`[side-panel] ${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined || pass ? '' : ` -- ${detail}`}`)
      record(name, pass, detail)
    }
    let app: ElectronApplication | undefined
    let id = ''
    try {
      app = await launchElectron({
        appPath: '.', args: [HERMETIC_RESOLVER], env: {}, sandbox: true,
        seedProfile: async (dir) => { id = seedFixture(dir, 'side-panel') }
      })
      const live = app
      await waitFor(async () => (await live.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)
      await waitRecovered(live)
      const chrome = findChrome(live)
      await navigateToFixture(live, fixtureUrl, 'side-panel-fixture /')
      const rpcPage = await openExtensionPage(live, id, 'rpc.html')
      const call = async (path: string, ...args: unknown[]): Promise<{ ok: boolean, result?: unknown, error?: string }> => await rpc(live, rpcPage, path, args) as never
      const log = async (): Promise<Array<{ event: string, info?: Record<string, unknown>, error?: string }>> => (await call('__log')).result as never
      const events = async (): Promise<string[]> => (await log()).map((entry) => entry.event)
      const shellWindow = await windowId(live)
      const actionSelector = `#${id}`
      await waitFor(async () => await chrome.evaluate((i: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${i}`) != null, id))

      const isOpen = async (): Promise<boolean> => await panel<boolean>(live, 'isOpen')
      const viewNow = async (): Promise<string> => await panel<string>(live, 'view')
      const panelShows = async (file: string): Promise<boolean> =>
        await waitFor(async () => pageOf(live, id, file) !== undefined && (await viewBounds(live, `chrome-extension://${id}/${file}`)) !== null)
      const closePanel = async (): Promise<void> => {
        await panel(live, 'close')
        await waitFor(async () => !(await isOpen()) && pageOf(live, id, 'panel.html') === undefined)
      }
      const closePopup = async (): Promise<void> => {
        const popup = pageOf(live, id, 'popup.html')
        if (popup === undefined) return
        await popup.evaluate(() => { window.close() }).catch(() => {})
        await waitFor(() => pageOf(live, id, 'popup.html') === undefined)
      }
      const frontTabId = async (): Promise<number> => {
        const tabs = (await call('chrome.tabs.query', { active: true, currentWindow: true })).result as Array<{ id: number }>
        return tabs[0]?.id ?? -1
      }

      // 1. The picker lists the extension, and choosing it puts the page at the panel's body.
      await panel(live, 'open')
      await waitFor(() => overlayOf(live) !== undefined)
      const overlay = overlayOf(live) as Page
      await overlay.waitForSelector('.sp-picker')
      await overlay.click('.sp-picker')
      const titles = await overlay.locator('.sp-choice .item-title').allInnerTexts()
      check('the picker lists the extension by name', titles.includes(NAME), JSON.stringify(titles))
      await overlay.locator('.sp-choice', { hasText: NAME }).click()
      check('choosing it shows panel.html', await panelShows('panel.html'))
      const body = await panel<Rect | null>(live, 'bodyBounds')
      const placed = await viewBounds(live, `chrome-extension://${id}/panel.html`)
      check('the page sits at the panel body', JSON.stringify(body) === JSON.stringify(placed), JSON.stringify({ body, placed }))
      check('the extension heard onOpened', (await events()).includes('onOpened'), JSON.stringify(await events()))
      await shoot(overlay, 'header')
      await shoot(pageOf(live, id, 'panel.html') as Page, 'guest')

      // 2. The page sees its own window.
      const panelPage = pageOf(live, id, 'panel.html') as Page
      const seen = await panelPage.evaluate(async () => ({
        tabs: await chrome.tabs.query({ currentWindow: true, active: true }),
        current: await chrome.windows.getCurrent(),
        contexts: await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] })
      }))
      check('tabs.query(currentWindow) answers the panel\'s window', seen.tabs.length === 1 && seen.tabs[0]?.windowId === shellWindow, JSON.stringify(seen.tabs))
      check('windows.getCurrent is the panel\'s window', seen.current.id === shellWindow, JSON.stringify(seen.current.id))
      check('getContexts lists SIDE_PANEL with the window', seen.contexts.length === 1 && seen.contexts[0]?.windowId === shellWindow, JSON.stringify(seen.contexts))

      // 3. window.open and a navigation off the extension open tabs, and the panel stays.
      const tabsBefore = (await tabIds(chrome)).length
      await panelPage.evaluate((url: string) => { window.open(url + 'opened') }, fixtureUrl)
      check('window.open from the panel opens a tab', await waitFor(async () => (await tabIds(chrome)).length === tabsBefore + 1))
      await panelPage.evaluate((url: string) => { location.href = url + 'navigated' }, fixtureUrl).catch(() => {})
      check('a navigation off the extension opens a tab', await waitFor(async () => (await tabIds(chrome)).length === tabsBefore + 2))
      check('the panel stays on its page', pageOf(live, id, 'panel.html')?.url().startsWith(`chrome-extension://${id}/panel.html`) === true)
      await closePanel()

      // 4. The toolbar button opens the panel when the extension asks for that, and a second click closes it.
      await call('__clear')
      check('setPanelBehavior is accepted', (await call('chrome.sidePanel.setPanelBehavior', { openPanelOnActionClick: true })).ok)
      check('getPanelBehavior answers it', JSON.stringify((await call('chrome.sidePanel.getPanelBehavior')).result) === '{"openPanelOnActionClick":true}')
      await chrome.click(actionSelector)
      check('a click opens the panel on the extension', await waitFor(async () => (await isOpen()) && (await viewNow()) === `ext:${id}`) && await panelShows('panel.html'))
      check('no popup opened and onClicked did not run', pageOf(live, id, 'popup.html') === undefined && !(await events()).includes('onClicked'))
      await chrome.click(actionSelector)
      check('a second click closes the panel', await waitFor(async () => !(await isOpen())))
      check('no popup opened on the closing click', pageOf(live, id, 'popup.html') === undefined)
      check('the extension heard onClosed', (await events()).includes('onClosed'), JSON.stringify(await events()))
      await call('chrome.action.openPopup')
      check('action.openPopup() opens the popup', await waitFor(() => pageOf(live, id, 'popup.html') !== undefined))
      check('and does not open the panel', !(await isOpen()))
      await closePopup()

      // 5. open() needs a gesture; from onClicked or after a click in the popup it works; the key toggles.
      await call('chrome.sidePanel.setPanelBehavior', { openPanelOnActionClick: false })
      await delay(5_200)
      const noGesture = await call('chrome.sidePanel.open', { windowId: shellWindow })
      check('open() without a gesture rejects', !noGesture.ok && /user gesture/.test(noGesture.error ?? ''), JSON.stringify(noGesture))
      // The popup comes from action.openPopup(), which records no gesture: only the click inside it can.
      await call('chrome.action.openPopup')
      check('action.openPopup() opens the popup', await waitFor(() => pageOf(live, id, 'popup.html') !== undefined))
      const popupOnly = await call('chrome.sidePanel.open', { windowId: shellWindow })
      check('open() still rejects: opening the popup was no gesture', !popupOnly.ok && /user gesture/.test(popupOnly.error ?? ''), JSON.stringify(popupOnly))
      await (pageOf(live, id, 'popup.html') as Page).click('#b')
      const afterClick = await call('chrome.sidePanel.open', { windowId: shellWindow })
      check('open() after a click in the popup succeeds', afterClick.ok, JSON.stringify(afterClick))
      check('and the panel opens', await waitFor(async () => (await isOpen()) && await panelShows('panel.html')))
      await closePopup()
      await closePanel()
      await chrome.click(actionSelector)
      check('with the behaviour off the click opens the popup', await waitFor(() => pageOf(live, id, 'popup.html') !== undefined))
      await closePopup()
      await call('chrome.action.setPopup', { popup: '' })
      await call('__arm', true)
      await call('__clear')
      await chrome.click(actionSelector)
      check('from onClicked, open() succeeds', await waitFor(async () => (await events()).includes('opened-from-onClicked')), JSON.stringify(await log()))
      await call('__arm', false)
      await closePanel()
      await call('chrome.action.setPopup', { popup: 'popup.html' })
      await pressKey(live, fixtureUrl, 'P', ['alt', 'shift'])
      check('the extension\'s key opens the panel', await waitFor(async () => (await isOpen()) && (await viewNow()) === `ext:${id}`))
      await pressKey(live, fixtureUrl, 'P', ['alt', 'shift'])
      check('and a second press closes it', await waitFor(async () => !(await isOpen())))

      // 6. Below the minimum width nothing can show: open() rejects and the click opens the popup.
      await call('chrome.sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
      await resize(live, 700, 600)
      await delay(500)
      await chrome.click(actionSelector)
      check('in a narrow window the click opens the popup', await waitFor(() => pageOf(live, id, 'popup.html') !== undefined))
      const narrow = await call('chrome.sidePanel.open', { windowId: shellWindow })
      check('and open() rejects, so the extension keeps its popup', !narrow.ok && /cannot be shown/.test(narrow.error ?? ''), JSON.stringify(narrow))
      await closePopup()
      await resize(live, 1280, 800)
      await delay(500)
      await call('chrome.sidePanel.setPanelBehavior', { openPanelOnActionClick: false })

      // 7. A panel of its own for one tab, and none for another; a tab switch brings it back without taking the keyboard.
      const first = await frontTabId()
      await panel(live, 'open', `ext:${id}`)
      check('the panel shows panel.html again', await panelShows('panel.html'))
      check('opening it gives the panel the keyboard', await waitFor(async () => await panel<boolean>(live, 'holdsFocus')))
      await call('chrome.sidePanel.setOptions', { tabId: first, path: 'tab.html' })
      check('a per-tab path swaps the page', await panelShows('tab.html'))
      await call('chrome.sidePanel.setOptions', { tabId: first, enabled: false })
      check('disabling it for the tab hides the panel', await waitFor(() => pageOf(live, id, 'tab.html') === undefined && pageOf(live, id, 'panel.html') === undefined))
      check('the panel itself stays open', await isOpen())
      await chrome.evaluate((url: string) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, `${fixtureUrl}second`)
      check('another tab brings the panel back', await panelShows('panel.html'))
      await delay(1_000)
      check('a panel brought back by a tab switch does not take the keyboard', !(await panel<boolean>(live, 'holdsFocus')))
      const second = await frontTabId()
      await call('chrome.sidePanel.setOptions', { tabId: second, path: 'tab.html' })
      check('a path set for the front tab swaps the page', await panelShows('tab.html'))
      await delay(1_000)
      check('and the swap leaves the keyboard where it was', !(await panel<boolean>(live, 'holdsFocus')))
      await call('chrome.tabs.update', first, { active: true })
      check('returning to the disabled tab hides it again', await waitFor(() => pageOf(live, id, 'tab.html') === undefined && pageOf(live, id, 'panel.html') === undefined))
      await call('chrome.sidePanel.setOptions', { tabId: first, enabled: true, path: 'panel.html' })
      await closePanel()

      // 8. The page's own window.close() closes the panel.
      await call('__clear')
      await panel(live, 'open', `ext:${id}`)
      await panelShows('panel.html')
      await (pageOf(live, id, 'panel.html') as Page).evaluate(() => { document.getElementById('back')?.click() }).catch(() => {})
      check('window.close() from the panel closes it', await waitFor(async () => !(await isOpen())))
      check('and the extension heard onClosed', await waitFor(async () => (await events()).includes('onClosed')), JSON.stringify(await log()))

      // 9. Disabling the extension takes the entry and the view away.
      await panel(live, 'open', `ext:${id}`)
      await panelShows('panel.html')
      const extensionsPage = await openExtensionsPage(live, chrome)
      const card = extensionsPage.locator('.ext-card', { has: extensionsPage.locator('.ext-name', { hasText: NAME }) })
      await card.locator('.switch input').click()
      check('disabling removes the panel view', await waitFor(() => pageOf(live, id, 'panel.html') === undefined))
      await waitFor(() => overlayOf(live) !== undefined)
      const choicesAfter = await (overlayOf(live) as Page).locator('.sp-choice .item-title').allInnerTexts()
      check('and the picker entry', !choicesAfter.includes(NAME), JSON.stringify(choicesAfter))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

async function installFixture (app: ElectronApplication): Promise<string> {
  const outcome = await answeringWith(app, 'Add extension', app.evaluate(async (_electron, dir: string) => {
    const hook = (globalThis as unknown as { __orivonDevExtensionsInstall?: { installFromFolder: (dir: string) => Promise<{ installed: boolean, entry?: { id: string } }> } }).__orivonDevExtensionsInstall
    if (hook === undefined) throw new Error('the install test hook is not installed: build with the e2e build script')
    return await hook.installFromFolder(dir)
  }, join(FIXTURES_DIR, 'side-panel')))
  expect(outcome.installed).toBe(true)
  if (outcome.entry === undefined) throw new Error('the install returned no entry')
  await waitRecovered(app)
  return outcome.entry.id
}

it('removing an extension with its panel open leaves nothing the page wrote back', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true })
  try {
    await stubNativeDialogs(app)
    const id = await installFixture(app)
    const chrome = findChrome(app)
    await panel(app, 'open', `ext:${id}`)
    expect(await waitFor(() => pageOf(app, id, 'panel.html') !== undefined)).toBe(true)
    const open = pageOf(app, id, 'panel.html') as Page
    await open.evaluate(() => { (window as unknown as { armed: boolean }).armed = true })
    expect(await waitFor(async () => (await open.evaluate(() => localStorage.getItem('tick'))) !== null)).toBe(true)

    const extensionsPage = await openExtensionsPage(app, chrome)
    const remove = extensionsPage.locator('.ext-card', { has: extensionsPage.locator('.ext-name', { hasText: NAME }) }).locator('button', { hasText: 'Remove' })
    await remove.click()
    await remove.click()
    expect(await waitFor(async () => (await extensionsPage.locator('.ext-name', { hasText: NAME }).count()) === 0)).toBe(true)
    expect(await waitFor(() => pageOf(app, id, 'panel.html') === undefined)).toBe(true)
    await delay(500)

    expect(await installFixture(app)).toBe(id)
    await panel(app, 'open', `ext:${id}`)
    expect(await waitFor(() => pageOf(app, id, 'panel.html') !== undefined)).toBe(true)
    const again = pageOf(app, id, 'panel.html') as Page
    expect(await again.evaluate(() => ({ armed: localStorage.getItem('armed'), tick: localStorage.getItem('tick') }))).toEqual({ armed: null, tick: null })
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
