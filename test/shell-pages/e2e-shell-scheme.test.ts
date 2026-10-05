// The shell's own pages load from `orivon-shell://renderer/...`, not from `file:` (src/main/pages/shell-scheme.ts):
// the chrome, the dashboard, the welcome screen, the main menu, both popovers and the split frame each load there
// with their bridge answering, and no web contents is on a `file:` URL. The two sessions that serve the scheme
// serve different files, a website cannot reach it, and Back to the dashboard from a site still works.
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCommand } from '../support/auth-support.js'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { launchShell, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, navigateThroughSelfDestroyingView, tabViews, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const SHELL = 'orivon-shell://renderer/'

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `${SHELL}newtab/index.html` })
      response.end()
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const pageWith = (app: ElectronApplication, part: string): Page | undefined =>
  app.windows().find((w) => w.url().includes(part) && !w.isClosed())

const urlsOf = async (app: ElectronApplication): Promise<string[]> =>
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL()))

async function waitForPage (app: ElectronApplication, part: string): Promise<Page> {
  expect(await waitFor(() => pageWith(app, part) !== undefined)).toBe(true)
  return pageWith(app, part) as Page
}

/** What `typeof window[name]` says in `page`. */
const bridgeOf = async (page: Page, name: string): Promise<string> =>
  await page.evaluate((key) => typeof (window as unknown as Record<string, unknown>)[key], name)

it('loads the chrome, the dashboard and the welcome screen from the shell scheme, each with its bridge', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_INTRO: 'once' } })
  try {
    expect(await waitFor(() => pageWith(app, '/intro/index.html') !== undefined && pageWith(app, '/newtab/index.html') !== undefined)).toBe(true)
    const chrome = findChrome(app)
    expect(chrome.url()).toBe(`${SHELL}index.html`)
    expect(await bridgeOf(chrome, 'orivonShell')).toBe('object')

    const dashboard = pageWith(app, '/newtab/index.html') as Page
    expect(dashboard.url()).toBe(`${SHELL}newtab/index.html`)
    expect(await bridgeOf(dashboard, 'orivonNewTab')).toBe('object')

    const intro = pageWith(app, '/intro/index.html') as Page
    expect(intro.url()).toBe(`${SHELL}intro/index.html`)
    expect(await intro.getAttribute('h1.headline', 'aria-label')).toBe('The browser Web3 deserves.')

    const urls = await urlsOf(app)
    expect(urls.filter((url) => url.startsWith('file:'))).toEqual([])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('loads the menu overlay, both popovers and the split frame from the shell scheme, each with its bridge', async () => {
  const { app, chrome } = await launchShell()
  try {
    await chrome.click('#menu')
    expect(await waitFor(() => pageWith(app, 'overlay=menu') !== undefined)).toBe(true)
    const menu = pageWith(app, 'overlay=menu') as Page
    expect(menu.url().startsWith(`${SHELL}overlay/index.html?overlay=menu`)).toBe(true)
    expect(await bridgeOf(menu, 'orivonOverlay')).toBe('object')
    await menu.keyboard.press('Escape')
    await delay(400)

    await visit(app, chrome, `${origin}/a`)
    await chrome.click('#site-permissions-btn')
    expect(await waitFor(() => pageWith(app, '/site-info/index.html') !== undefined)).toBe(true)
    const info = pageWith(app, '/site-info/index.html') as Page
    expect(info.url().startsWith(`${SHELL}site-info/index.html`)).toBe(true)
    expect(await bridgeOf(info, 'orivonSiteInfo')).toBe('object')
    await info.keyboard.press('Escape').catch(() => undefined)
    expect(await waitFor(() => pageWith(app, '/site-info/index.html') === undefined)).toBe(true)

    await chrome.click('#permissions-btn')
    expect(await waitFor(() => pageWith(app, '/permissions/index.html') !== undefined)).toBe(true)
    const permissions = pageWith(app, '/permissions/index.html') as Page
    expect(permissions.url().startsWith(`${SHELL}permissions/index.html`)).toBe(true)
    expect(await bridgeOf(permissions, 'orivonPermissions')).toBe('object')
    await permissions.keyboard.press('Escape').catch(() => undefined)
    expect(await waitFor(() => pageWith(app, '/permissions/index.html') === undefined)).toBe(true)

    await chrome.click('#new-tab')
    await visit(app, chrome, `${origin}/b`)
    await chrome.locator('.tab', { hasText: 'Page /a' }).click()
    await runCommand(chrome, 'split.toggle')
    expect(await waitFor(() => pageWith(app, '/split-frame/index.html') !== undefined)).toBe(true)
    const frame = pageWith(app, '/split-frame/index.html') as Page
    expect(frame.url()).toBe(`${SHELL}split-frame/index.html`)
    expect(await bridgeOf(frame, 'orivonSplit')).toBe('object')

    expect((await urlsOf(app)).filter((url) => url.startsWith('file:'))).toEqual([])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('serves each session only its own files: the shell partition its pages and assets, the default session the dashboard\'s files', async () => {
  const { app } = await launchShell()
  try {
    const manifest = JSON.parse(readFileSync('out/renderer/.vite/manifest.json', 'utf8')) as Record<string, { file: string, css?: string[] }>
    const newtabCss = (manifest['newtab/index.html']?.css ?? [])[0] as string
    const chromeCss = (manifest['index.html']?.css ?? [])[0] as string
    const chromeScript = (manifest['index.html'] as { file: string }).file

    // The shell partition answers for what the shell's own pages load, and for no page of the dashboard's.
    const shellStatus = async (path: string): Promise<number> =>
      await app.evaluate(async ({ session }, target) => (await session.fromPartition('persist:orivon-shell').fetch(`orivon-shell://renderer/${target}`)).status, path)
    expect(await shellStatus('index.html')).toBe(200)
    expect(await shellStatus(chromeScript)).toBe(200)
    expect(await shellStatus(chromeCss)).toBe(200)
    expect(await shellStatus('newtab/index.html')).toBe(404)
    expect(await shellStatus('.vite/manifest.json')).toBe(404)

    // The default session answers the dashboard's own page for the dashboard, and the files of other pages with 404.
    const dashboard = await waitForPage(app, '/newtab/index.html')
    const loads = async (href: string): Promise<boolean> => await dashboard.evaluate((target) =>
      new Promise<boolean>((resolve) => {
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: target })
        link.onload = () => { resolve(true) }
        link.onerror = () => { resolve(false) }
        document.head.appendChild(link)
      }), `${SHELL}${href}`)
    expect(await loads(newtabCss)).toBe(true)
    expect(await loads(chromeCss)).toBe(false)
    expect(await loads('.vite/manifest.json')).toBe(false)
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

/** The built new-tab page's own script, as a path the scheme would serve it at. */
function newtabScript (): string {
  const manifest = JSON.parse(readFileSync('out/renderer/.vite/manifest.json', 'utf8')) as Record<string, { file: string }>
  return `${SHELL}${(manifest['newtab/index.html'] as { file: string }).file}`
}

it('gives a loopback page no way to load, frame, navigate to or fetch a page of the shell', async () => {
  const { app, chrome } = await launchShell()
  try {
    const site = await visit(app, chrome, `${origin}/a`)
    const script = newtabScript()
    const outcome = async (make: string): Promise<string> => await site.evaluate((code) =>
      new Promise<string>((resolve) => {
        const el = (0, eval)(code) as HTMLElement
        el.onload = () => { resolve('load') }
        el.onerror = () => { resolve('error') }
        document.body.appendChild(el)
        setTimeout(() => { resolve('timeout') }, 4000)
      }), make)

    expect(await outcome(`Object.assign(document.createElement('script'), { src: ${JSON.stringify(script)} })`)).not.toBe('load')
    expect(await outcome(`Object.assign(document.createElement('link'), { rel: 'stylesheet', href: ${JSON.stringify(script)} })`)).not.toBe('load')
    expect(await outcome(`Object.assign(new Image(), { src: ${JSON.stringify(`${SHELL}assets/logo-x.png`)} })`)).not.toBe('load')
    expect(await site.evaluate((target) => fetch(target).then(() => 'fetched', () => 'rejected'), script)).toBe('rejected')

    // A frame, a navigation, a redirect and a new window: none reaches the page.
    await site.evaluate((target) => {
      const frame = document.createElement('iframe')
      frame.src = target
      document.body.appendChild(frame)
      window.open(target)
    }, `${SHELL}newtab/index.html`)
    await delay(ABSENCE_SETTLE_MS)
    const shellContents = async (): Promise<string[]> => (await urlsOf(app)).filter((url) => url.includes('/newtab/'))
    const frames = async (): Promise<string[]> => await app.evaluate(({ webContents }, address) =>
      webContents.getAllWebContents().find((wc) => wc.getURL() === address)?.mainFrame.framesInSubtree.map((frame) => frame.url) ?? [], `${origin}/a`)
    expect((await frames()).filter((url) => url.startsWith('orivon-shell:'))).toEqual([])
    expect(await shellContents()).toEqual([])

    await site.evaluate((target) => { location.href = target }, `${SHELL}newtab/index.html`)
    await delay(ABSENCE_SETTLE_MS)
    expect(await shellContents()).toEqual([])
    const [view] = tabViews(app, chrome)
    expect(view?.url()).toBe(`${origin}/a`)

    await site.evaluate(() => { location.href = '/redirect' })
    await delay(ABSENCE_SETTLE_MS)
    expect(await shellContents()).toEqual([])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

async function dashboardWithBookmark (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    seedProfile: async (dir) => { await writeFile(join(dir, 'bookmarks.json'), JSON.stringify([{ url: `${origin}/one`, title: 'First page', favicon: null }])) }
  })
  expect(await waitFor(() => pageWith(app, '/newtab/index.html') !== undefined)).toBe(true)
  return { app, chrome: findChrome(app) }
}

it('still shows the dashboard working after a visit to a site and Back: bookmarks render and the search navigates', async () => {
  const { app, chrome } = await dashboardWithBookmark()
  try {
    const dashboard = pageWith(app, '/newtab/index.html') as Page
    expect(await waitFor(async () => await dashboard.locator('#bookmarks-grid .tile').count() === 1)).toBe(true)
    await dashboard.locator('#bookmarks-grid .tile').click()
    expect(await waitFor(() => tabViews(app, chrome).some((view: Page) => view.url() === `${origin}/one`))).toBe(true)

    await chrome.click('#back')
    expect(await waitFor(() => pageWith(app, '/newtab/index.html') !== undefined)).toBe(true)
    const back = pageWith(app, '/newtab/index.html') as Page
    expect(await waitFor(async () => await back.locator('#bookmarks-grid .tile').count() === 1)).toBe(true)

    await back.fill('#search-input', `${origin}/two`)
    const result = await navigateThroughSelfDestroyingView(app, chrome, back, '#search-input', 'Enter', `${origin}/two`)
    expect(result.navigated).toBe(true)
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('copies a tab that went dashboard then site without the dashboard, so Back from the copy has nowhere to go', async () => {
  const { app, chrome } = await dashboardWithBookmark()
  try {
    const dashboard = pageWith(app, '/newtab/index.html') as Page
    await dashboard.locator('#bookmarks-grid .tile').click()
    expect(await waitFor(() => tabViews(app, chrome).some((view: Page) => view.url() === `${origin}/one`))).toBe(true)

    await runCommand(chrome, 'tab.duplicate')
    const histories = async (): Promise<string[][]> => await app.evaluate(({ webContents }, address) =>
      webContents.getAllWebContents().filter((wc) => wc.getURL() === address).map((wc) => wc.navigationHistory.getAllEntries().map((entry) => entry.url)), `${origin}/one`)
    expect(await waitFor(async () => (await histories()).length === 2)).toBe(true)
    expect(await waitFor(async () => (await histories()).some((urls) => urls.length === 1))).toBe(true)
    const entries = await histories()
    const copy = entries.find((urls) => urls.length === 1) as string[]
    expect(copy).toEqual([`${origin}/one`])
    expect(entries.flat().filter((url) => url.startsWith('file:'))).toEqual([])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
