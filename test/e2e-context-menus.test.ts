// What a right-click in a tab offers, and what choosing each item does: the
// link, image, video, selection, editable and page menus, Paste and Go in the
// address bar, and spell checking following its setting. Native menus cannot be
// seen, so Menu.prototype.popup is replaced to keep the last menu built, and
// items are chosen by calling their click. No real clipboard is read or written
// and no save dialog opens (a will-download listener names the file).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const SELECTED = 'orivon context menu selection text for the search'
const SHOTS = process.env['ORIVON_SHOTS_DIR']

let server: Server
let origin = ''
let hits = 0
/** Requests to /pwned: what a script that ran from pasted text would leave behind. */
let pwned = 0
let scratch = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orivon-ctx-'))
  server = createServer((request, response) => {
    if (request.url === '/i.png') {
      response.setHeader('content-type', 'image/png')
      response.end(PNG)
      return
    }
    response.setHeader('content-type', 'text/html')
    if (request.url === '/pwned') pwned += 1
    if (request.url === '/') {
      hits += 1
      response.end(`<!doctype html><title>Fixture</title><body style="margin:0">
        <p><a id="link" href="/target">A link to follow</a></p>
        <p><a id="picture-link" href="/target"><img id="linked" src="/i.png" width="40" height="40"></a></p>
        <p><img id="img" src="/i.png" width="40" height="40"></p>
        <p id="text">${SELECTED}</p>
        <p><input id="field" value="typed text"></p>
        <p><video id="vid" src="/v.webm" width="120" height="60" controls></video></p>
        <div id="empty" style="height:200px"></div></body>`)
      return
    }
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

interface Item { label: string, type: string, enabled: boolean, checked: boolean }
type MenuHolder = { __orivonLastMenu?: { items: Array<{ label: string, type: string, enabled: boolean, checked: boolean, click: () => void }> } | undefined }

async function launched (seed?: (dir: string) => Promise<void>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(seed === undefined ? {} : { seedProfile: seed }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () { (globalThis as MenuHolder).__orivonLastMenu = this as never }
  })
  return { app, chrome: findChrome(app) }
}

async function visit (app: ElectronApplication, chrome: Page, path: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, `${origin}${path}`)
  expect((await waitForTab(chrome, { address: `${origin}${path}` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, `${origin}${path}`) !== undefined)).toBe(true)
  return findViewShowing(app, chrome, `${origin}${path}`) as Page
}

async function rightClick (app: ElectronApplication, page: Page, selector: string): Promise<Item[]> {
  await app.evaluate(() => { (globalThis as MenuHolder).__orivonLastMenu = undefined })
  await page.click(selector, { button: 'right' })
  expect(await waitFor(async () => await app.evaluate(() => (globalThis as MenuHolder).__orivonLastMenu !== undefined))).toBe(true)
  return await app.evaluate(() => ((globalThis as MenuHolder).__orivonLastMenu?.items ?? [])
    .map(({ label, type, enabled, checked }) => ({ label, type, enabled, checked })))
}

async function choose (app: ElectronApplication, label: string): Promise<void> {
  const found = await app.evaluate((_electron, wanted) => {
    const item = (globalThis as MenuHolder).__orivonLastMenu?.items.find((candidate) => candidate.label === wanted)
    if (item === undefined) return false
    item.click()
    return true
  }, label)
  expect(found, `no item "${label}"`).toBe(true)
}

// Inspect Element closes every menu where developer tools are allowed, which is the default; it is checked once, below.
const labelsOf = (items: Item[]): string[] => {
  const labels = items.map((item) => item.type === 'separator' ? '|' : item.label)
  return labels.slice(-2).join() === '|,Inspect Element' ? labels.slice(0, -2) : labels
}
const tabUrls = async (app: ElectronApplication): Promise<string[]> =>
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL()))

it('offers the link set on a link, and opens it in a new tab beside the one being read', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    const items = await rightClick(app, page, '#link')
    expect(labelsOf(items).slice(0, 8)).toEqual([
      'Open Link in New Tab', 'Open Link in New Window', 'Open Link in Private Window', 'Open Link in Split View', '|',
      'Save Link As…', 'Copy Link Address', 'Copy Link Text'
    ])
    const before = (await tabIds(chrome)).length
    await choose(app, 'Open Link in New Tab')
    expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
    expect(await waitFor(async () => (await tabUrls(app)).includes(`${origin}/target`))).toBe(true)
    // In the background: the page that was being read is still the one in front.
    expect(await page.evaluate(() => location.pathname)).toBe('/')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the image set, the link set above it for a linked image, and the video set', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    expect(labelsOf(await rightClick(app, page, '#img'))).toEqual(['Open Image in New Tab', 'Save Image As…', 'Copy Image', 'Copy Image Address'])

    const linked = labelsOf(await rightClick(app, page, '#linked'))
    expect(linked.indexOf('Open Link in New Tab')).toBeGreaterThanOrEqual(0)
    expect(linked.indexOf('Open Link in New Tab')).toBeLessThan(linked.indexOf('Open Image in New Tab'))

    const video = labelsOf(await rightClick(app, page, '#vid'))
    expect(video).toEqual(expect.arrayContaining(['Open Video in New Tab', 'Save Video As…', 'Copy Video Address']))

    await choose(app, 'Open Video in New Tab')
    expect(await waitFor(async () => (await tabUrls(app)).includes(`${origin}/v.webm`))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('searches a selection with the chosen engine in a tab put in front', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    await page.click('#text', { clickCount: 3 })
    const items = await rightClick(app, page, '#text')
    const labels = labelsOf(items)
    expect(labels[0]).toBe('Copy')
    expect(labels[1]).toBe('Search DuckDuckGo for “orivon context menu selection…”')
    await choose(app, labels[1] as string)
    // The hermetic resolver fails the load, so only the address is checked.
    expect(await waitFor(async () => (await tabUrls(app)).some((url) => url.startsWith('https://duckduckgo.com/?q=orivon+context+menu+selection+text')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('saves a link into the file a will-download listener names, without a dialog', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    const saved = join(scratch, 'saved.html')
    await app.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => { item.setSavePath(path) })
    }, saved)
    await rightClick(app, page, '#link')
    await choose(app, 'Save Link As…')
    expect(await waitFor(() => existsSync(saved))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the page set on empty space, and Reload loads the page again', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    const items = await rightClick(app, page, '#empty')
    expect(labelsOf(items)).toEqual([
      'Back', 'Forward', 'Reload', '|', 'Save Page As…', 'Print…', 'Take a Screenshot', '|', 'View Page Source'
    ])
    const canGoBack = await app.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.navigationHistory.canGoBack(), `${origin}/`)
    expect(items.find((item) => item.label === 'Back')?.enabled).toBe(canGoBack)
    expect(items.find((item) => item.label === 'Forward')?.enabled).toBe(false)

    const before = hits
    await choose(app, 'Reload')
    expect(await waitFor(() => hits > before)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the edit set in a field and switches spell checking off from it', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    expect(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())).toBe(true)
    const items = await rightClick(app, page, '#field')
    expect(labelsOf(items)).toEqual([
      'Undo', 'Redo', '|', 'Cut', 'Copy', 'Paste', 'Paste as Plain Text', '|', 'Select All', '|', 'Check Spelling'
    ])
    expect(items.find((item) => item.label === 'Check Spelling')).toMatchObject({ type: 'checkbox', checked: true })
    await choose(app, 'Check Spelling')
    expect(await waitFor(async () => !(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('checks no spelling in any tab when the setting is off at launch', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'spellcheck.enabled': false } }))
  })
  try {
    const page = await visit(app, chrome, '/')
    expect(await waitFor(async () => !(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())))).toBe(true)
    const items = await rightClick(app, page, '#field')
    expect(items.find((item) => item.label === 'Check Spelling')).toMatchObject({ checked: false })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('gives the address bar Paste and Go, which submits the clipboard text as typed', async () => {
  const { app, chrome } = await launched()
  try {
    const target = `${origin}/pasted`
    // The real clipboard can hang under a virtual display: the reader is replaced.
    await app.evaluate(({ clipboard }, url) => { clipboard.readText = async () => url }, target)
    const items = await rightClick(app, chrome, '#address')
    expect(labelsOf(items)).toEqual(['Undo', 'Redo', '|', 'Cut', 'Copy', 'Paste', 'Paste and Go', 'Paste as Plain Text', '|', 'Select All'])
    await choose(app, 'Paste and Go')
    expect(await waitFor(async () => (await tabUrls(app)).includes(target))).toBe(true)
    expect((await waitForTab(chrome, { address: target })).ok).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('never runs a script pasted into Paste and Go, and leaves the tab on a page that cannot run it', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(app, chrome, '/')
    pwned = 0
    await app.evaluate(({ clipboard }, url) => { clipboard.readText = async () => `javascript:fetch('${url}')` }, `${origin}/pwned`)
    await rightClick(app, chrome, '#address')
    await choose(app, 'Paste and Go')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    // Nothing ran: a script that had would have reached this server.
    expect(pwned).toBe(0)
    const urls = await tabUrls(app)
    expect(urls.some((url) => url.startsWith('javascript:'))).toBe(false)
    // The refused text leaves the tab on a blank page, or where it was: never on one that took the text for an address.
    const pages = urls.filter((url) => /^(https?:|about:|javascript:)/.test(url))
    expect(pages.every((url) => url === 'about:blank' || url.startsWith(origin)), pages.join(' ')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the Settings row for spell checking in light and dark', async () => {
  const { app, chrome } = await launched()
  try {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/content') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-spellcheck')
    expect(await settings.locator('#row-spellcheck .row-help').textContent()).toContain('Dictionaries are downloaded once per language.')
    if (SHOTS !== undefined) {
      await mkdir(SHOTS, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        // A virtual display never changes the page's media query, so the scheme is emulated on the page.
        await settings.emulateMedia({ colorScheme: theme })
        expect(await settings.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
        await settings.screenshot({ path: join(SHOTS, `settings-page-content-${theme}.png`) })
      }
    }
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a link in a window of its own, last because it leaves a second chrome behind', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await visit(app, chrome, '/')
    await rightClick(app, page, '#link')
    await choose(app, 'Open Link in New Window')
    expect(await waitFor(async () => (await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)) === 2)).toBe(true)
    expect(await waitFor(async () => (await tabUrls(app)).includes(`${origin}/target`))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
