// The address bar at rest and the QR sheet, in the running shell: the elided address over the real input, the
// click that selects it, the connection mark for plain http, live https and local pages, the setting and the
// menu tick that flip full addresses, and the QR sheet with Copy link and Download. A native menu cannot be
// seen, so Menu.prototype.popup keeps the last one built and an item is chosen by calling its click. Set
// ORIVON_UI_SHOTS_DIR to also write screenshots of each state in both colour schemes.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttps } from 'node:https'
import { createServer as createTcp } from 'node:net'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, popoverShown, waitFor, waitForTab } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const PAGE_WITH_FILE_LINK = (href: string): string => `<!doctype html><title>Linker</title><a id="file" href="${href}" style="font:20px sans-serif">a local file</a>`
const PAGE = '<!doctype html><title>Fixture page</title><body style="font:16px sans-serif"><h1>Fixture page</h1><p>Some text to right-click.</p></body>'

let http: FixtureServer
let https: Server
let httpsOrigin = ''
let scratch = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orivon-address-bar-'))
  http = await startServer((_request, response) => { html(response, PAGE) })
  // A self-signed certificate for 127.0.0.1, accepted through the launch switch below: the only way a test can
  // hold a page the tab reached over a live https connection.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore' })
  https = createHttps({ key: readFileSync(join(scratch, 'key.pem')), cert: readFileSync(join(scratch, 'cert.pem')) }, (_request, response) => { html(response, PAGE) })
  await new Promise<void>((resolve) => { https.listen(0, '127.0.0.1', resolve) })
  httpsOrigin = `https://127.0.0.1:${String((https.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await http.close()
  await new Promise<void>((resolve) => { https.close(() => { resolve() }); https.closeAllConnections() })
  await rm(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** A port nothing listens on: the connection to it is refused. */
async function freePort (): Promise<number> {
  const probe = createTcp()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  return port
}

type App = ElectronApplication
type MenuHolder = { __orivonLastMenu?: { items: Array<{ label: string, type: string, checked: boolean, click: () => void }> } | undefined }

/** Plain http to `insecure.test` reaches the fixture; every other name is still refused. */
const LAUNCH = {
  args: [
    '--host-resolver-rules=MAP insecure.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--ignore-certificate-errors'
  ]
}

async function launched (): Promise<{ app: App, chrome: Page }> {
  const shell = await launchShell(LAUNCH)
  await shell.app.evaluate(({ Menu }) => { Menu.prototype.popup = function () { (globalThis as MenuHolder).__orivonLastMenu = this as never } })
  return shell
}

const displayText = async (chrome: Page): Promise<string> => (await chrome.locator('#address-display .address-text').textContent()) ?? ''
const hostText = async (chrome: Page): Promise<string> => (await chrome.locator('#address-display .address-host').allTextContents()).join('')
const markText = async (chrome: Page): Promise<string> => (await chrome.locator('#address-display .address-mark').allTextContents()).join('')
const markTitle = async (chrome: Page): Promise<string | null> => await chrome.locator('#address-display .address-mark').first().getAttribute('title').catch(() => null)
const inputValue = async (chrome: Page): Promise<string> => await chrome.locator('#address').inputValue()

async function waitDisplay (chrome: Page, text: string): Promise<void> {
  let last = ''
  const ok = await waitFor(async () => { last = await displayText(chrome); return last === text })
  expect({ ok, last }).toEqual({ ok: true, last: text })
}

async function selection (chrome: Page): Promise<{ focused: boolean, start: number | null, end: number | null, length: number }> {
  return await chrome.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#address') as HTMLInputElement
    return { focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, length: input.value.length }
  })
}

const displayShown = async (chrome: Page): Promise<boolean> =>
  await chrome.evaluate(() => getComputedStyle(document.querySelector('#address-display') as Element).visibility === 'visible')
const inputOpacity = async (chrome: Page): Promise<string> =>
  await chrome.evaluate(() => getComputedStyle(document.querySelector('#address') as Element).opacity)

async function setScheme (app: App, chrome: Page, scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  await chrome.emulateMedia({ colorScheme: scheme })
  await delay(300)
}

/** The toolbar row in both schemes; the chrome view is the whole top of the window. */
async function shoot (app: App, chrome: Page, name: string, overlay?: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(app, chrome, scheme)
    if (overlay !== undefined) await overlay.emulateMedia({ colorScheme: scheme })
    await delay(200)
    await chrome.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
    if (overlay !== undefined) await overlay.screenshot({ path: join(SHOTS_DIR, `${name}-sheet-${scheme}.png`) })
  }
  await setScheme(app, chrome, 'light')
  if (overlay !== undefined) await overlay.emulateMedia({ colorScheme: null })
}

const qrPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=qr'))
const qrShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=qr')

async function openQr (app: App, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('page.qr') })
  expect(await waitFor(async () => await qrShown(app))).toBe(true)
  expect(await waitFor(() => qrPage(app) !== undefined)).toBe(true)
  const sheet = qrPage(app) as Page
  await sheet.waitForSelector('.qr-tile svg path')
  return sheet
}

async function rightClickAddress (app: App, chrome: Page): Promise<Array<{ label: string, type: string, checked: boolean }>> {
  await app.evaluate(() => { (globalThis as MenuHolder).__orivonLastMenu = undefined })
  await chrome.click('#address', { button: 'right' })
  expect(await waitFor(async () => await app.evaluate(() => (globalThis as MenuHolder).__orivonLastMenu !== undefined))).toBe(true)
  return await app.evaluate(() => ((globalThis as MenuHolder).__orivonLastMenu?.items ?? []).map(({ label, type, checked }) => ({ label, type, checked })))
}

async function choose (app: App, label: string): Promise<void> {
  const found = await app.evaluate((_electron, wanted) => {
    const item = (globalThis as MenuHolder).__orivonLastMenu?.items.find((candidate) => candidate.label === wanted)
    if (item === undefined) return false
    item.click()
    return true
  }, label)
  expect(found, `no item "${label}"`).toBe(true)
}

it('elides the address over the real input, selects it on a click and restores on Escape', async () => {
  const { app, chrome } = await launched()
  try {
    // A fresh tab: nothing elided, the input and its placeholder show.
    expect(await chrome.locator('#address-display').textContent()).toBe('')
    expect(await inputOpacity(chrome)).toBe('1')
    expect(await chrome.locator('#address').getAttribute('placeholder')).toBe('Search or enter address')

    const url = `${http.origin}/docs/page?tab=1`
    await visit(app, chrome, url)
    await waitDisplay(chrome, `${http.origin.replace('http://', '')}/docs/page?tab=1`)
    expect(await hostText(chrome)).toBe('127.0.0.1')
    expect(await inputValue(chrome)).toBe(url)
    expect(await inputOpacity(chrome)).toBe('0')
    expect(await displayShown(chrome)).toBe(true)
    // Plain http to this machine says nothing: no lock, no warning.
    expect(await chrome.locator('#address-display .address-mark').count()).toBe(0)
    await shoot(app, chrome, 'http-local')

    // The first click selects the whole address and shows it; the display steps aside in the same frame.
    await chrome.click('#address')
    expect(await selection(chrome)).toEqual({ focused: true, start: 0, end: url.length, length: url.length })
    expect(await displayShown(chrome)).toBe(false)
    expect(await inputOpacity(chrome)).toBe('1')
    await shoot(app, chrome, 'focused')

    // A second click places the caret instead.
    await chrome.click('#address', { position: { x: 30, y: 10 } })
    const caret = await selection(chrome)
    expect(caret.focused).toBe(true)
    expect(caret.end === caret.start).toBe(true)

    // Escape gives the display back and the input its page address.
    await chrome.keyboard.press('Escape')
    expect(await waitFor(async () => (await selection(chrome)).focused === false)).toBe(true)
    expect(await displayShown(chrome)).toBe(true)
    expect(await inputValue(chrome)).toBe(url)

    // Typed text and Enter still go through the real input, unchanged.
    await clickAddressBarRetrying(chrome, `${http.origin}/other`)
    expect((await waitForTab(chrome, { address: `${http.origin}/other` })).ok).toBe(true)
    await waitDisplay(chrome, `${http.origin.replace('http://', '')}/other`)

    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('marks plain http to a public name as not secure, live https with a lock, and a shell page with neither', async () => {
  const { app, chrome } = await launched()
  try {
    const insecure = `http://insecure.test:${http.origin.split(':')[2] ?? ''}/a`
    await visit(app, chrome, insecure)
    await waitDisplay(chrome, `insecure.test:${http.origin.split(':')[2] ?? ''}/a`)
    expect(await markText(chrome)).toBe('Not secure')
    expect(await markTitle(chrome)).toBe('This site does not use a secure connection. Do not enter passwords or card numbers.')
    expect(await hostText(chrome)).toBe('insecure.test')
    await shoot(app, chrome, 'http-not-secure')

    await clickAddressBarRetrying(chrome, `${httpsOrigin}/secure`)
    await waitDisplay(chrome, `${httpsOrigin.replace('https://', '')}/secure`)
    // A secure connection draws no glyph of its own beside the shield and the key: the key's title says it.
    expect(await chrome.locator('#address-display .address-mark').count()).toBe(0)
    // The key shows on every web page, since the site's permissions are listed behind it.
    expect(await chrome.locator('#site-permissions-btn').isVisible()).toBe(true)
    expect(await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'aria-label')) === 'Permissions. Connection is secure')).toBe(true)
    await shoot(app, chrome, 'https')

    // A load that fails commits Chromium's error page under the address that failed: it has no lock either.
    const dead = await freePort()
    await clickAddressBarRetrying(chrome, `https://127.0.0.1:${String(dead)}/gone`)
    await waitDisplay(chrome, `127.0.0.1:${String(dead)}/gone`)
    await delay(ABSENCE_SETTLE_MS)
    expect(await chrome.locator('#address-display .address-mark').count()).toBe(0)

    // A shell page keeps its scheme and gets no mark: the lock would describe nothing it serves.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('settings') })
    expect(await waitFor(async () => (await displayText(chrome)).startsWith('orivon://settings'))).toBe(true)
    expect(await chrome.locator('#address-display .address-mark').count()).toBe(0)
    expect(await chrome.locator('#site-permissions-btn').isVisible()).toBe(false)
    expect(await hostText(chrome)).toBe('settings')
    await shoot(app, chrome, 'protocol')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('shows full addresses from the setting, and the address menu\'s tick flips it', async () => {
  const { app, chrome } = await launched()
  try {
    const url = `${httpsOrigin}/full?x=1`
    await visit(app, chrome, url)
    await waitDisplay(chrome, `${httpsOrigin.replace('https://', '')}/full?x=1`)

    let items = await rightClickAddress(app, chrome)
    expect(items.at(-1)).toEqual({ label: 'Always Show Full Addresses', type: 'checkbox', checked: false })
    expect(items.map((item) => item.label)).toContain('Paste and Go')
    await choose(app, 'Always Show Full Addresses')
    await waitDisplay(chrome, url)
    expect(await hostText(chrome)).toBe('127.0.0.1')

    items = await rightClickAddress(app, chrome)
    expect(items.at(-1)).toEqual({ label: 'Always Show Full Addresses', type: 'checkbox', checked: true })
    await chrome.keyboard.press('Escape')
    expect(await waitFor(async () => await displayShown(chrome))).toBe(true)
    await shoot(app, chrome, 'full-address')

    // The Settings row is the same switch.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/search') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-address-bar-full-urls')
    expect(await settings.locator('#row-address-bar-full-urls input').isChecked()).toBe(true)
    expect(await settings.locator('#row-address-bar-full-urls').textContent()).toContain('Always show full addresses')
    await settings.locator('#row-address-bar-full-urls input').uncheck({ force: true })
    expect(await waitFor(async () => !(await settings.locator('#row-address-bar-full-urls input').isChecked()))).toBe(true)

    // Back on the page, the display is elided again.
    await chrome.evaluate(() => { document.querySelector<HTMLElement>('.tab')?.click() })
    await waitDisplay(chrome, `${httpsOrigin.replace('https://', '')}/full?x=1`)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('opens the QR sheet for a page, copies the link, saves the picture, and does nothing on a new tab', async () => {
  const downloads = join(scratch, 'downloads')
  mkdirSync(downloads)
  const { app, chrome } = await launched()
  try {
    await app.evaluate(({ app: electronApp }, dir) => { electronApp.setPath('downloads', dir) }, downloads)

    // A new tab has no page to share.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('page.qr') })
    await delay(ABSENCE_SETTLE_MS)
    expect(await qrShown(app)).toBe(false)

    const url = `${http.origin}/qr`
    const page = await visit(app, chrome, url)
    const sheet = await openQr(app, chrome)
    expect(await sheet.locator('.sheet-title').textContent()).toBe('Scan to open this page')
    expect(await sheet.locator('.qr-address').textContent()).toBe(url)
    expect(await sheet.locator('.qr-address').getAttribute('title')).toBe(url)
    const box = await sheet.locator('.qr-tile svg').boundingBox()
    expect(box === null ? null : [Math.round(box.width), Math.round(box.height)]).toEqual([232, 232])
    expect((await sheet.locator('.qr-tile svg path').getAttribute('d'))?.length ?? 0).toBeGreaterThan(200)
    expect(await sheet.locator('.qr-tile').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    expect(await sheet.locator('.btn-row .btn').allTextContents()).toEqual(['Download', 'Copy link'])
    expect(await waitFor(async () => await sheet.evaluate(() => document.activeElement?.textContent === 'Copy link'))).toBe(true)
    await shoot(app, chrome, 'qr', sheet)

    const stillOpen = async (step: string): Promise<void> => { expect({ step, shown: await qrShown(app) }).toEqual({ step, shown: true }) }
    await stillOpen('before copy')
    await sheet.locator('.btn.primary').click()
    expect(await waitFor(async () => (await sheet.locator('.btn.primary').textContent()) === 'Copied')).toBe(true)
    expect(await waitFor(async () => (await sheet.locator('.btn.primary').textContent()) === 'Copy link', 6000)).toBe(true)

    await stillOpen('after copy')
    await sheet.locator('.btn-row .btn').first().click()
    expect(await waitFor(async () => (await sheet.locator('.btn-row .btn').first().textContent()) === 'Saved to Downloads')).toBe(true)
    expect(await waitFor(() => existsSync(join(downloads, 'qr-127.0.0.1.png')))).toBe(true)
    const png = readFileSync(join(downloads, 'qr-127.0.0.1.png'))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(readdirSync(downloads)).toEqual(['qr-127.0.0.1.png'])
    await stillOpen('after download')

    // Escape closes it, and the page gets the keys back.
    // The sheet's own page is destroyed under the key, so the press may end with the page already gone.
    try { await sheet.keyboard.press('Escape') } catch (error) { if (!/closed/.test(String(error))) throw error }
    expect(await waitFor(async () => !(await qrShown(app)))).toBe(true)

    // A navigation closes it too.
    await openQr(app, chrome)
    await page.evaluate(() => { location.href = '/elsewhere' })
    expect(await waitFor(async () => !(await qrShown(app)))).toBe(true)

    // The page's right-click menu offers it, and choosing it opens the sheet.
    await delay(400)
    await app.evaluate(() => { (globalThis as MenuHolder).__orivonLastMenu = undefined })
    const current = await waitForPage(app, chrome, `${http.origin}/elsewhere`)
    await current.click('p', { button: 'right' })
    expect(await waitFor(async () => await app.evaluate(() => (globalThis as MenuHolder).__orivonLastMenu !== undefined))).toBe(true)
    await choose(app, 'Create QR Code for This Page')
    expect(await waitFor(async () => await qrShown(app))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

async function waitForPage (app: App, chrome: Page, url: string): Promise<Page> {
  expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
  let view: Page | undefined
  expect(await waitFor(() => { view = app.windows().find((w) => w.url() === url); return view !== undefined })).toBe(true)
  return view as Page
}

it('loads no file: address, whether a web page links to it or it is typed', async () => {
  const local = join(scratch, 'local.html')
  await writeFile(local, '<!doctype html><title>Local file</title><p>from disk</p>')
  const linker = await startServer((_request, response) => { html(response, PAGE_WITH_FILE_LINK(`file://${local}`)) })
  const { app, chrome } = await launched()
  const urls = async (): Promise<string[]> => await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL()))
  try {
    const page = await visit(app, chrome, `${linker.origin}/`)
    const before = await urls()
    await page.click('#file')
    // A refusal cannot be polled for: wait it out, then read.
    await delay(ABSENCE_SETTLE_MS)
    expect(await urls()).toEqual(before)
    expect(await inputValue(chrome)).toBe(`${linker.origin}/`)

    // Typed, the address is turned away and the tab is left on a blank page with an empty bar.
    await clickAddressBarRetrying(chrome, `file://${local}`)
    expect(await waitFor(async () => (await urls()).includes('about:blank'))).toBe(true)
    expect((await urls()).some((url) => url.startsWith('file://') && url.endsWith('local.html'))).toBe(false)
    expect(await inputValue(chrome)).toBe('')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await linker.close()
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
