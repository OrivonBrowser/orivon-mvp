// The features that work on a page work the same on every kind of page: an
// ordinary website, an address served from IPFS and verified, and an app that
// holds permissions in its own session. For each kind, in the real shell: the
// page is remembered in history under the address a person sees, zoomed and
// remembered per site, opened in developer tools (the app asks first), shown
// beside another tab in a split, and moved to a window of its own without the
// page being loaded again.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from './question-support.js'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

let server: Server
let origin = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>
let siteCid = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><meta charset="utf-8"><title>Kind ${request.url ?? ''}</title><body><p>${request.url ?? ''}</p></body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  gateway = await startFixtureGateway({ site: { 'index.html': '<!doctype html><meta charset="utf-8"><title>Kind ipfs</title><body><p>from ipfs</p></body>' } })
  siteCid = gateway.roots['site'] as string
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await gateway.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

interface Kind {
  readonly name: string
  /** What is typed to open it. */
  readonly typed: () => string
  /** The address a person sees for it, and history keeps. */
  readonly shown: () => string
  /** A part of the address its page really has, to find it. */
  readonly loaded: () => string
  /** The origin its zoom is kept under. */
  readonly siteOrigin: () => string
  readonly isApp: boolean
}

const KINDS: Kind[] = [
  { name: 'an ordinary website', typed: () => `${origin}/site`, shown: () => `${origin}/site`, loaded: () => `${origin}/site`, siteOrigin: () => origin, isApp: false },
  { name: 'an address served from IPFS', typed: () => `ipfs://${CID.parse(siteCid).toV0().toString()}`, shown: () => `ipfs://${siteCid}/`, loaded: () => `${siteCid}.ipfs.orivon`, siteOrigin: () => `https://${siteCid}.ipfs.orivon`, isApp: false },
  { name: 'an app that holds a permission', typed: () => `${origin}/app`, shown: () => `${origin}/app`, loaded: () => `${origin}/app`, siteOrigin: () => origin, isApp: true }
]

function manifest (): Manifest {
  return { orivonApiVersion: 0, id: 'app.orivon.tab-kinds-e2e', name: 'Tab kinds e2e fixture', version: '1.0.0', entry: 'index.html', assets: [], capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } } }
}

const chromePages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))
const factorAt = async (app: ElectronApplication, part: string): Promise<number | null> =>
  await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((c) => c.getURL().includes(p))?.getZoomFactor() ?? null, part)
const toolsOpenAt = async (app: ElectronApplication, part: string): Promise<boolean | null> =>
  await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().find((c) => c.getURL().includes(p))?.isDevToolsOpened() ?? null, part)
const chip = async (chrome: Page): Promise<string | null> =>
  await evaluateRetrying(chrome, () => { const el = document.querySelector<HTMLElement>('#zoom-chip'); return el === null || el.hidden ? null : el.textContent })
const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

for (const kind of KINDS) {
  it(`works on ${kind.name}: history, zoom, developer tools, split view and moving to a window`, async () => {
    const app = await launchElectron({
      appPath: '.',
      args: [HERMETIC_RESOLVER],
      env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
    })
    try {
      expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
      const chrome = findChrome(app)
      const userData = await userDataOf(app)
      await stubNativeDialogs(app)
      expect(await waitFor(async () => await app.evaluate(() => (globalThis as { __orivonDevEthFixtures?: { listening: boolean } }).__orivonDevEthFixtures?.listening === true), 20_000)).toBe(true)

      if (kind.isApp) {
        const registered = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return false
          await hook(request)
          return true
        }, { origin, manifest: manifest(), capability: 'tcp.connect', patterns: ['127.0.0.1:9'] } satisfies DevGrantRequest)
        expect(registered).toBe(true)
      }

      await clickAddressBarRetrying(chrome, kind.typed())
      expect((await waitForTab(chrome, { address: kind.shown() })).ok).toBe(true)
      const part = kind.loaded()

      // History keeps it under the address that is shown.
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('history') })
      expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://history')))).toBe(true)
      const history = app.windows().find((w) => w.url().startsWith('orivon://history')) as Page
      await history.waitForSelector('.page')
      expect(await waitFor(async () => (await history.locator('.entry .url').allTextContents()).includes(kind.shown()))).toBe(true)
      // Closing the History tab leaves the page in front.
      await runCommand(chrome, 'tab.close')
      expect((await waitForTab(chrome, { address: kind.shown() })).ok).toBe(true)

      // Zoom, kept for the site.
      await pressKey(app, part, '=', ['control'])
      expect(await waitFor(async () => Math.abs((await factorAt(app, part) ?? 0) - 1.1) < 0.001)).toBe(true)
      expect(await waitFor(async () => await chip(chrome) === '110%')).toBe(true)
      expect(await waitFor(() => { try { return (JSON.parse(readFileSync(join(userData, 'zoom.json'), 'utf8')) as { levels: Record<string, number> }).levels[kind.siteOrigin()] === 110 } catch { return false } })).toBe(true)

      // Developer tools open and close; an app asks once.
      await pressKey(app, part, 'F12')
      if (kind.isApp) {
        expect((await readQuestion(await waitQuestion(app))).message).toContain(origin)
        await answerQuestion(app, 'Open developer tools')
      }
      expect(await waitFor(async () => await toolsOpenAt(app, part) === true)).toBe(true)
      await pressKey(app, part, 'F12')
      expect(await waitFor(async () => await toolsOpenAt(app, part) === false)).toBe(true)
      await pressKey(app, part, 'F12')
      expect(await waitFor(async () => await toolsOpenAt(app, part) === true)).toBe(true)
      await pressKey(app, part, 'F12')
      expect(await waitFor(async () => await toolsOpenAt(app, part) === false)).toBe(true)
      expect(await questionGone(app)).toBe(true)
      expect(await noNativeDialogs(app)).toEqual([])

      // Split view: shown beside the other tab, each in its pane, and separated again.
      const pageView = async (): Promise<{ url: string, width: number }[]> => await app.evaluate(({ BaseWindow }, p) => {
        const [win] = BaseWindow.getAllWindows()
        return (win?.contentView.children ?? []).flatMap((child) => {
          const contents = (child as unknown as { webContents?: { getURL: () => string } }).webContents
          return contents?.getURL().includes(p) === true ? [{ url: contents.getURL(), width: child.getBounds().width }] : []
        })
      }, part)
      // Another tab to be beside; the page's own tab is the one in front.
      await runCommand(chrome, 'tab.new')
      expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
      await chrome.locator('.tab').first().click()
      expect((await waitForTab(chrome, { address: kind.shown() })).ok).toBe(true)
      const whole = (await pageView())[0]?.width ?? 0
      await runCommand(chrome, 'split.toggle')
      expect(await waitFor(async () => { const now = (await pageView())[0]?.width ?? 0; return now > 0 && now < whole - 200 })).toBe(true)
      await runCommand(chrome, 'split.toggle')
      expect(await waitFor(async () => Math.abs(((await pageView())[0]?.width ?? 0) - whole) <= 1)).toBe(true)

      // Moved to a window of its own: the same page, not loaded again.
      const view = app.windows().find((w) => w.url().includes(part)) as Page
      await view.evaluate(() => { (window as unknown as { __marker: string }).__marker = 'kept' })
      const before = (await tabIds(chrome)).length
      await runCommand(chrome, 'tab.moveToNewWindow')
      expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
      expect(await waitFor(async () => (await tabIds(chrome)).length === before - 1)).toBe(true)
      expect(await view.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('kept')
    } finally {
      await closeElectron(app)
    }
  }, TEST_TIMEOUT_MS)
}

// The dashboard's own pre-paint colour (tab-factory.ts, theme-colors.ts's
// DASHBOARD_BACKGROUND) must not bleed through a site with no CSS background of
// its own once the SAME tab navigates there -- the common case, since a
// site with no grants yet needs no partition swap and so never gets a
// freshly built, colourless view. capturePage() throws UnknownVizError
// under this machine's headless GPU-less xvfb, so this reads the recorded
// colour through view-background-test-hook.ts instead of a real pixel.
it('resets the dashboard tab\'s background once it navigates to a plain site with no CSS background', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)

    const dashboardId = async (): Promise<number | undefined> =>
      await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('/newtab/'))?.id)
    const recordedBackground = async (id: number | undefined): Promise<string | undefined> =>
      id === undefined ? undefined : await app.evaluate((_e, wcId: number) =>
        (globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string> }).__orivonDevViewBackgrounds?.get(wcId), id)
    // NOT dashboardId() again -- once this tab has navigated away it no
    // longer matches '/newtab/', which is exactly the point: this checks
    // the SAME id (by getAllWebContents' own id, not by re-deriving a URL
    // match) is still alive, proving no rebuild happened.
    const stillAlive = async (wcId: number | undefined): Promise<boolean> =>
      wcId !== undefined && await app.evaluate(({ webContents }, i: number) => webContents.getAllWebContents().some((wc) => wc.id === i), wcId)

    // The dashboard tab loads after the chrome view appears: wait for both it and its recorded colour.
    let id: number | undefined
    expect(await waitFor(async () => { id = await dashboardId(); return (await recordedBackground(id)) !== undefined })).toBe(true)
    // The dashboard's colour for the scheme the machine is in (theme-colors.ts; e2e-theme-backing.test.ts pins each).
    const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    expect(await recordedBackground(id)).toBe(dark ? '#0d0e14' : '#394244')

    await clickAddressBarRetrying(chrome, `${origin}/site`)
    expect((await waitForTab(chrome, { address: `${origin}/site` })).ok).toBe(true)

    // The same webContents, not a rebuilt one: the site has no grants yet,
    // so partitionChanged() sees no swap and this tab's own view is reused.
    expect(await stillAlive(id)).toBe(true)
    expect(await waitFor(async () => (await recordedBackground(id)) === '#FFFFFF')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
