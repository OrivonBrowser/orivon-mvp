// A wallet extension asking the person to approve a page's request: a real click on the page opens the extension's
// side panel and no window; a request made with no click shows one popup window, and the next such request finds that
// window again by its type and id (`windows.getAll`) and brings it to the front instead of opening another; removing
// the popup tells the extension and lets the next request open a new one.
//
// Fixture: test/apps/extensions/dapp-requests/ (the page -> content script -> worker -> content script -> worker
// round trip a wallet uses to learn that the person just clicked). Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-dapp-requests.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture } from '../support/e2e-helpers.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 300_000
const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function fixtureServer (): Promise<string> {
  const created = createServer((_request, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>dapp-requests-fixture</title><body><button id="go" onclick="window.postMessage({ type: \'dapp-request\' }, \'*\')">Send transaction</button></body>')
  })
  servers.push(created)
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}/`
}

interface LogEntry { event: string, id?: number, type?: string, left?: number, top?: number, width?: number, height?: number, senderTabId?: number | null, error?: string }
interface WindowInfo { id: number, type: string }
type SidePanelSeam = { host: (index: number) => Record<string, (...args: unknown[]) => unknown> }

const pageOf = (app: ElectronApplication, id: string, file: string): Page | undefined =>
  app.windows().find((w) => w.url().startsWith(`chrome-extension://${id}/${file}`))

/** The shell windows: the ones holding the chrome view. */
async function shellWindowCount (app: ElectronApplication): Promise<number> {
  return await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter((win) =>
    win.contentView.children.some((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().endsWith('/renderer/index.html') === true)).length)
}

async function sidePanelOpen (app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(() => (globalThis as unknown as { __orivonDevSidePanel: SidePanelSeam }).__orivonDevSidePanel.host(0)['isOpen']?.() as boolean)
}

async function closeSidePanel (app: ElectronApplication): Promise<void> {
  await app.evaluate(() => { (globalThis as unknown as { __orivonDevSidePanel: SidePanelSeam }).__orivonDevSidePanel.host(0)['close']?.() })
  expect(await waitFor(async () => !(await sidePanelOpen(app)))).toBe(true)
}

it('opens the side panel from a click, and keeps one popup window for the requests that have no click', async () => {
  const fixtureUrl = await fixtureServer()
  let app: ElectronApplication | undefined
  try {
    let id = ''
    app = await launchElectron({
      appPath: '.', args: [HERMETIC_RESOLVER], env: {}, sandbox: true,
      seedProfile: async (dir) => { id = seedFixture(dir, 'dapp-requests') }
    })
    const live = app
    await waitFor(async () => (await live.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)
    await waitRecovered(live)
    const page = await navigateToFixture(live, fixtureUrl, 'dapp-requests-fixture')
    const rpcPage = await openExtensionPage(live, id, 'rpc.html')
    const call = async (path: string, ...args: unknown[]): Promise<unknown> => {
      const reply = await rpc(live, rpcPage, path, args)
      if (!reply.ok) throw new Error(`${path} failed: ${reply.error}`)
      return reply.result
    }
    const log = async (): Promise<LogEntry[]> => await call('__log') as LogEntry[]
    const events = async (): Promise<string[]> => (await log()).map((entry) => entry.event)
    const windows = async (): Promise<WindowInfo[]> => await call('chrome.windows.getAll') as WindowInfo[]
    const popups = async (): Promise<WindowInfo[]> => (await windows()).filter((w) => w.type === 'popup')
    // A request the page makes with no input at all: a script's own click event carries no user activation.
    const requestWithoutClick = async (): Promise<void> => {
      await page.evaluate(() => { document.getElementById('go')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }

    // 1. A real click: the worker hears it from a content script, asks the content script back, and opens the panel.
    const windowsBefore = await shellWindowCount(live)
    await page.click('#go')
    expect(await waitFor(async () => (await events()).includes('side-panel-opened'), 15_000), JSON.stringify(await log())).toBe(true)
    expect(await waitFor(async () => (await sidePanelOpen(live)) && pageOf(live, id, 'panel.html') !== undefined)).toBe(true)
    const afterClick = await log()
    const request = afterClick.find((entry) => entry.event === 'dapp-request')
    const opening = afterClick.find((entry) => entry.event === 'open-sidepanel-message')
    expect(typeof request?.senderTabId).toBe('number')
    expect(opening?.senderTabId).toBe(request?.senderTabId)
    expect(afterClick.map((entry) => entry.event)).toContain('content-script-reached')
    expect(await shellWindowCount(live)).toBe(windowsBefore)
    expect(await popups()).toEqual([])

    // 2. No click: the panel is not opened, and one popup window is shown, as a popup, at the size and place asked.
    await closeSidePanel(live)
    await call('__clear')
    await requestWithoutClick()
    expect(await waitFor(async () => (await events()).includes('popup-created'), 15_000), JSON.stringify(await log())).toBe(true)
    expect(await sidePanelOpen(live)).toBe(false)
    const created = (await log()).find((entry) => entry.event === 'popup-created')
    expect(created?.type).toBe('popup')
    expect(await waitFor(async () => (await shellWindowCount(live)) === windowsBefore + 1)).toBe(true)
    const listed = await popups()
    expect(listed.map((w) => w.id)).toEqual([created?.id])
    expect((await windows()).filter((w) => w.type === 'normal').length).toBe(windowsBefore)
    const bounds = await live.evaluate(({ BaseWindow }, wanted: number) => BaseWindow.fromId(wanted)?.getBounds() ?? null, created?.id as number)
    expect(bounds).toMatchObject({ x: 120, y: 80, height: 620 })
    expect(bounds?.width).toBeGreaterThanOrEqual(500)

    // 3. The next request without a click finds that popup again and brings it forward: no second window.
    await call('__clear')
    await requestWithoutClick()
    expect(await waitFor(async () => (await events()).includes('popup-refocused'), 15_000), JSON.stringify(await log())).toBe(true)
    expect(await events()).not.toContain('popup-created')
    expect((await log()).find((entry) => entry.event === 'popup-refocused')?.id).toBe(created?.id)
    expect(await shellWindowCount(live)).toBe(windowsBefore + 1)
    expect((await popups()).map((w) => w.id)).toEqual([created?.id])

    // 4. Removing the popup tells the extension, and the next request opens one new popup.
    await call('__clear')
    await call('chrome.windows.remove', created?.id)
    expect(await waitFor(async () => (await events()).includes('window-removed'))).toBe(true)
    expect((await log()).some((entry) => entry.event === 'window-removed' && entry.id === created?.id)).toBe(true)
    expect(await waitFor(async () => (await shellWindowCount(live)) === windowsBefore)).toBe(true)
    expect(await popups()).toEqual([])
    await call('__clear')
    await requestWithoutClick()
    expect(await waitFor(async () => (await events()).includes('popup-created'), 15_000), JSON.stringify(await log())).toBe(true)
    const next = (await log()).find((entry) => entry.event === 'popup-created')
    expect(next?.id).not.toBe(created?.id)
    expect(await waitFor(async () => (await shellWindowCount(live)) === windowsBefore + 1)).toBe(true)
    expect((await popups()).map((w) => w.id)).toEqual([next?.id])
  } finally {
    if (app !== undefined) await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
