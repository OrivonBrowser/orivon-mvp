// Orivon as the computer's browser, in the running shell: a link handed over by another program opens in a tab of
// the running window, Settings says whether Orivon is the default browser and never registers it from a source
// run, a newer release is one click away, a page is shared as a copied link or an email, and a site becomes a
// shortcut in a directory the test chose (the applications directory on Linux, the desktop on Windows; macOS makes
// none). The clipboard, the mail program and the default-browser
// calls are replaced in the main process, so nothing reaches the machine. Set ORIVON_UI_SHOTS_DIR to also write
// screenshots of the new surfaces in both colour schemes.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const PROFILE = '0123456789ab'
const electronBinary = createRequire(import.meta.url)('electron') as string

/** Every character a shortcut file or a mail address must not let a page control. */
const TITLE = 'Fixture "os" links & more %f $(id) \\ end'
const QUERY = '?q=$(id)&r=%f;x'

let server: Server
let origin = ''
const scratch: string[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    const path = request.url?.split('?')[0] ?? '/'
    const title = path === '/' ? TITLE.replace('&', '&amp;') : `Page ${path}`
    response.end(`<!doctype html><title>${title}</title><body style="font:16px sans-serif"><h1>${path}</h1></body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

function scratchDir (name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orivon-os-links-${name}-`))
  scratch.push(dir)
  return dir
}

async function launched (options: { args?: string[], env?: Record<string, string>, seed?: (dir: string) => void } = {}): Promise<{ app: App, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.seed === undefined ? {} : { seedProfile: (dir: string) => { options.seed?.(dir) } })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function visit (chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

/** Runs Orivon to completion, for a launch that is meant to end at once. */
async function runToExit (args: string[], userData: string, timeoutMs = 20_000): Promise<number | null> {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronBinary, ['.', `--user-data-dir=${userData}`, '--no-sandbox', ...args], { env, stdio: 'ignore' })
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

interface Recorded { clipboard: string[], opened: string[], setDefault: string[], isDefault: string[] }

/** Replaces, in the main process, everything that would reach the machine, and records what was asked of it. */
async function stubSystem (app: App): Promise<void> {
  await app.evaluate(({ app: electron, clipboard, shell }) => {
    const g = globalThis as unknown as { __os: Recorded }
    g.__os = { clipboard: [], opened: [], setDefault: [], isDefault: [] }
    clipboard.writeText = ((text: string) => { g.__os.clipboard.push(text) }) as typeof clipboard.writeText
    shell.openExternal = (async (url: string) => { g.__os.opened.push(url) }) as typeof shell.openExternal
    electron.setAsDefaultProtocolClient = ((protocol: string) => {
      g.__os.setDefault.push(protocol)
      return false
    }) as typeof electron.setAsDefaultProtocolClient
    electron.isDefaultProtocolClient = ((protocol: string) => { g.__os.isDefault.push(protocol); return false }) as typeof electron.isDefaultProtocolClient
  })
}

const recorded = async (app: App): Promise<Recorded> => await app.evaluate(() => (globalThis as unknown as { __os: Recorded }).__os)

async function runCommand (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

async function openSettings (app: App, chrome: Page, path: string): Promise<Page> {
  await chrome.evaluate((at) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', at) }, path)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('.layout')
  return page
}

const toastPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=toast'))

async function toastText (app: App): Promise<string | null> {
  if (!(await popoverShown(app, 'overlay=toast'))) return null
  const page = toastPage(app)
  if (page === undefined) return null
  try { return (await page.locator('.toast').innerText({ timeout: 500 })).replace(/\s+/g, ' ').trim() } catch { return null }
}

const waitForToast = async (app: App, text: string): Promise<boolean> => await waitFor(async () => (await toastText(app))?.startsWith(text) === true)

async function menuPage (app: App, chrome: Page): Promise<Page> {
  await chrome.click('#menu')
  expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
  expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=menu')))).toBe(true)
  const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
  await menu.waitForSelector('.menu-row')
  return menu
}

/** The main menu, drilled into the submenu named `submenu`. */
async function menuSubmenu (app: App, chrome: Page, submenu: string): Promise<Page> {
  const menu = await menuPage(app, chrome)
  await menu.locator('.menu-row', { hasText: submenu }).click()
  await menu.locator('.menu-back').waitFor()
  return menu
}

async function shoot (app: App, page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  const chrome = findChrome(app)
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await page.emulateMedia({ colorScheme: scheme })
    await delay(300)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await chrome.emulateMedia({ colorScheme: null })
  await page.emulateMedia({ colorScheme: null })
}

const sheetPage = (app: App): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=shortcut-sheet') && !w.isClosed()).at(-1)

async function waitSheet (app: App): Promise<Page> {
  expect(await waitFor(async () => await popoverShown(app, 'overlay=shortcut-sheet'))).toBe(true)
  expect(await waitFor(() => sheetPage(app) !== undefined)).toBe(true)
  const sheet = sheetPage(app) as Page
  await sheet.waitForSelector('.shortcut-sheet input.text')
  return sheet
}

const entries = (dir: string): string[] => { try { return readdirSync(join(dir, 'applications')).sort() } catch { return [] } }

const WINDOWS = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const MAKE_DEFAULT = WINDOWS ? 'Open Windows Settings' : 'Make default'
const WINDOWS_HANDOFF = 'Choose Orivon for web links in Windows Settings. The button opens them again.'
const MAC_HANDOFF = 'Confirm in the system\'s prompt to make Orivon the default.'

/** Windows puts a shortcut on the desktop; the test points the desktop at a scratch folder first, so the person's own is never touched. */
async function redirectDesktop (app: App, dir: string): Promise<void> {
  await app.evaluate(({ app: electron }, desktop) => { electron.setPath('desktop', desktop) }, dir)
}

const links = (desktop: string): string[] => { try { return readdirSync(desktop).sort() } catch { return [] } }

/** What the test chose as the place shortcuts go: the applications directory on Linux, the redirected desktop on Windows. */
const written = (data: string, desktop: string): string[] => WINDOWS ? links(desktop) : entries(data)

interface Link { target: string, args: string, description: string }

const readLinks = async (app: App, desktop: string): Promise<Link[]> => await app.evaluate(({ shell }, paths) => paths.map((path) => {
  const { target, args, description } = shell.readShortcutLink(path)
  return { target, args: args ?? '', description: description ?? '' }
}), links(desktop).map((file) => join(desktop, file)))

const samePath = (a: string, b: string): boolean => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

it('opens an address another program hands over as a tab of the running window, and drops every other scheme', async () => {
  const { app, chrome } = await launched()
  try {
    const dir = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)

    // A second start, as a link clicked in another program makes it on Linux and Windows.
    expect(await runToExit([`${origin}/second-launch`], dir)).toBe(0)
    expect((await waitForTab(chrome, { address: `${origin}/second-launch` })).ok).toBe(true)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)

    // macOS hands the link to the running app as an event.
    const prevented = await app.evaluate(({ app: electron }, url) => {
      let claimed = false
      electron.emit('open-url', { preventDefault: () => { claimed = true } }, url)
      return claimed
    }, `${origin}/open-url`)
    expect(prevented).toBe(true)
    expect((await waitForTab(chrome, { address: `${origin}/open-url` })).ok).toBe(true)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 3)).toBe(true)

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'orivon://settings', 'data:text/html,x']) {
      await app.evaluate(({ app: electron }, bad) => { electron.emit('open-url', { preventDefault: () => {} }, bad) }, url)
    }
    await delay(ABSENCE_SETTLE_MS)
    expect((await tabIds(chrome)).length).toBe(3)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

interface SeamRecording { isDefault: string[], setDefault: string[], opened: number, registered: boolean }

/** What the test seam's recording host was asked: it stands in for the operating system (ORIVON_TEST_DEFAULT_BROWSER). */
const seamRecording = async (app: App): Promise<SeamRecording> => await app.evaluate(() => (globalThis as unknown as { __orivonDevDefaultBrowser: SeamRecording }).__orivonDevDefaultBrowser)

it('says why Orivon cannot be made the default browser from a run like this one, offers no button, and never calls the system', async () => {
  const { app, chrome } = await launched()
  try {
    await stubSystem(app)
    const page = await openSettings(app, chrome, '/default-browser')
    expect(await page.locator('.nav-list').innerText()).toContain('Default browser')
    const row = page.locator('#row-default-browser')
    await row.waitFor()
    expect(await row.locator('.row-label').textContent()).toBe('Default browser')
    // A test build never names a run from source's desktop entry, so on Linux the row says how to add one.
    expect(await row.locator('.row-control').textContent()).toContain(process.platform === 'linux'
      ? 'Not available until Orivon (source) is in your app list'
      : 'Not available while Orivon runs from its source folder.')
    expect(await row.locator('button').count()).toBe(0)
    await delay(ABSENCE_SETTLE_MS)
    const calls = await recorded(app)
    expect(calls.setDefault).toEqual([])
    expect(calls.isDefault).toEqual([])
    await shoot(app, page, 'default-browser-unavailable')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

const rowSays = async (row: Locator, text: string): Promise<boolean> => await waitFor(async () => (await row.locator('.row-control').textContent())?.includes(text) === true, 10_000)

it('registers for both web protocols when the build is installed (on Windows, opens the system\'s settings, where the choice is the person\'s)', async () => {
  const { app, chrome } = await launched({ env: { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' } })
  try {
    const page = await openSettings(app, chrome, '/default-browser')
    const row = page.locator('#row-default-browser')
    const button = row.getByRole('button', { name: MAKE_DEFAULT })
    await button.waitFor()
    await shoot(app, page, 'default-browser-can-set')
    await button.click()
    if (WINDOWS) {
      // Windows lets only the person choose: Orivon opens the page where they do and registers nothing.
      expect(await rowSays(row, WINDOWS_HANDOFF)).toBe(true)
      expect(await row.getByRole('button', { name: MAKE_DEFAULT }).isEnabled()).toBe(true)
      expect(await seamRecording(app)).toMatchObject({ opened: 1, setDefault: [], registered: false })
      // The person chose Orivon there and came back.
      await app.evaluate(() => { (globalThis as unknown as { __orivonDevDefaultBrowser: SeamRecording }).__orivonDevDefaultBrowser.registered = true })
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    expect(await rowSays(row, 'Orivon is your default browser.')).toBe(true)
    expect(await row.locator('button').count()).toBe(0)
    expect((await seamRecording(app)).setDefault).toEqual(WINDOWS ? [] : ['http', 'https'])
    await shoot(app, page, 'default-browser-done')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says the system did not accept the change and gives the command to do it by hand (Linux), or hands the choice to the person (Windows, macOS)', async () => {
  const { app, chrome } = await launched({ env: { ORIVON_TEST_DEFAULT_BROWSER: 'declined' } })
  try {
    const page = await openSettings(app, chrome, '/default-browser')
    const button = page.locator('#row-default-browser').getByRole('button', { name: MAKE_DEFAULT })
    await button.waitFor()
    await button.click()
    if (process.platform !== 'linux') {
      // Windows opens its settings and never registers; macOS asks for a registration and leaves the confirmation
      // to the person. Neither calls a refusal an error.
      const row = page.locator('#row-default-browser')
      expect(await rowSays(row, WINDOWS ? WINDOWS_HANDOFF : MAC_HANDOFF)).toBe(true)
      expect(await row.locator('.problem').count()).toBe(0)
      expect(await row.getByRole('button', { name: MAKE_DEFAULT }).isEnabled()).toBe(true)
      expect(await seamRecording(app)).toMatchObject(WINDOWS ? { opened: 1, setDefault: [] } : { opened: 0, setDefault: ['http', 'https'] })
      expect(mainOutput(app)).not.toContain('uncaught exception')
      return
    }
    const problem = page.locator('#row-default-browser .problem')
    await problem.waitFor({ timeout: 10_000 })
    expect(await problem.textContent()).toBe('Your system did not accept the change.')
    // The command to do it by hand sits on the label's side of the row, with a button that copies it.
    expect(await page.locator('#row-default-browser .command-line code').textContent()).toBe('xdg-mime default orivon.desktop x-scheme-handler/http x-scheme-handler/https')
    expect(await page.locator('#row-default-browser .command-line button').textContent()).toBe('Copy')
    expect(await page.locator('#row-default-browser').getByRole('button', { name: 'Make default' }).isEnabled()).toBe(true)
    expect((await seamRecording(app)).setDefault).toEqual(['http', 'https'])
    await shoot(app, page, 'default-browser-declined')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('reads the answer again when the person comes back to the page', async () => {
  const { app, chrome } = await launched({ env: { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' } })
  try {
    const page = await openSettings(app, chrome, '/default-browser')
    const row = page.locator('#row-default-browser')
    await row.getByRole('button', { name: 'Make default' }).waitFor()
    // The person chose Orivon in the system's own settings while the page was in the background.
    await app.evaluate(() => { (globalThis as unknown as { __orivonDevDefaultBrowser: SeamRecording }).__orivonDevDefaultBrowser.registered = true })
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(await waitFor(async () => (await row.locator('.row-control').textContent())?.includes('Orivon is your default browser.') === true, 10_000)).toBe(true)
    expect((await seamRecording(app)).setDefault).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the page of a newer release from Settings, in a tab of the same window, and installs nothing', async () => {
  const { app, chrome } = await launched()
  try {
    await app.evaluate(({ net }) => {
      net.fetch = (async () => new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof net.fetch
    })
    const page = await openSettings(app, chrome, '/about')
    expect(await page.locator('#row-updates-release').count()).toBe(0)
    await page.locator('#row-updates-now').getByRole('button', { name: 'Check for an update' }).click()
    const banner = page.locator('#row-updates-release .banner.info')
    await banner.waitFor({ timeout: 10_000 })
    expect((await banner.innerText()).replace(/\s+/g, ' ')).toContain('Orivon 9.9.9 is available.')
    // The plain sentence gives way to the banner: the version is not said twice.
    expect(await page.locator('#row-updates-result').count()).toBe(0)
    await shoot(app, page, 'about-release')

    const before = (await tabIds(chrome)).length
    await banner.getByRole('button', { name: 'Open release page' }).click()
    expect((await waitForTab(chrome, { address: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v9.9.9' })).ok).toBe(true)
    expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('copies the address of the page in front and says so, and has nothing to copy on a page of Orivon\'s own', async () => {
  const { app, chrome } = await launched()
  try {
    await stubSystem(app)
    await stubNativeDialogs(app)
    const address = `${origin}/${QUERY}`
    await visit(chrome, address)

    await runCommand(chrome, 'share.copyLink')
    expect(await waitForToast(app, 'Link copied')).toBe(true)
    expect((await recorded(app)).clipboard).toEqual([address])
    const toast = toastPage(app) as Page
    await shoot(app, toast, 'toast-link-copied')

    const settings = await openSettings(app, chrome, '/about')
    expect(settings).toBeDefined()
    await runCommand(chrome, 'share.copyLink')
    expect(await waitForToast(app, 'This page has no address to share')).toBe(true)
    expect((await recorded(app)).clipboard).toEqual([address])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('starts an email about the page only after the person agrees, with the title and the address percent-encoded', async () => {
  const { app, chrome } = await launched()
  try {
    await stubSystem(app)
    await stubNativeDialogs(app)
    const address = `${origin}/${QUERY}`
    await visit(chrome, address)
    const mailto = `mailto:?subject=${encodeURIComponent(TITLE)}&body=${encodeURIComponent(address)}`

    await runCommand(chrome, 'share.email')
    const question = await readQuestion(await waitQuestion(app))
    expect(question.message).toBe('Open your mail program with this page\'s link?')
    expect(question.detail).toContain('127.0.0.1')
    expect(question.detail).toContain('mailto:?subject=')
    await answerQuestion(app, 'Cancel')
    await delay(ABSENCE_SETTLE_MS)
    expect((await recorded(app)).opened).toEqual([])

    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await runCommand(chrome, 'share.email')
    await answerQuestion(app, 'Allow')
    expect(await waitFor(async () => (await recorded(app)).opened.length === 1)).toBe(true)
    expect((await recorded(app)).opened).toEqual([mailto])
    expect(mailto).not.toMatch(/[\r\n ]/)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('lists Copy link, Email link and the QR code under Share, greyed with the reason on a page that has no address', async () => {
  const { app, chrome } = await launched()
  try {
    await stubSystem(app)
    await visit(chrome, `${origin}/menu`)
    const share = await menuSubmenu(app, chrome, 'Share')
    const rows = share.locator('.menu-row:not(.menu-back)')
    expect(await rows.allInnerTexts().then((texts) => texts.map((text) => text.split('\n')[0]))).toEqual(['Copy link', 'Email link', 'Create QR code'])
    expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute('aria-disabled')))).toEqual([null, null, null])
    await shoot(app, share, 'menu-share')
    await share.getByRole('menuitem', { name: /^Copy link/ }).click()
    expect(await waitForToast(app, 'Link copied')).toBe(true)
    expect((await recorded(app)).clipboard).toEqual([`${origin}/menu`])

    await openSettings(app, chrome, '/about')
    const grey = await menuSubmenu(app, chrome, 'Share')
    const copy = grey.getByRole('menuitem', { name: /^Copy link/ })
    expect(await copy.getAttribute('aria-disabled')).toBe('true')
    expect(await copy.innerText()).toContain('No address')
    expect(await grey.getByRole('menuitem', { name: /^Email link/ }).getAttribute('aria-disabled')).toBe('true')
    await shoot(app, grey, 'menu-share-no-address')
    await copy.dispatchEvent('click')
    await delay(ABSENCE_SETTLE_MS)
    expect((await recorded(app)).clipboard).toHaveLength(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(MAC)('makes a shortcut from the sheet into the directory the test chose (applications on Linux, the desktop on Windows), cleaned and quoted, and refuses a folder it cannot write', async () => {
  const data = scratchDir('xdg')
  const desktop = scratchDir('desktop')
  const { app, chrome } = await launched({ env: { XDG_DATA_HOME: data } })
  try {
    if (WINDOWS) await redirectDesktop(app, desktop)
    await stubSystem(app)
    await stubNativeDialogs(app)
    const address = `${origin}/${QUERY}`
    await visit(chrome, address)

    const menu = await menuSubmenu(app, chrome, 'More tools')
    const row = menu.getByRole('menuitem', { name: /^Create shortcut/ })
    expect(await row.getAttribute('aria-disabled')).toBeNull()
    await row.click()
    const sheet = await waitSheet(app)
    expect(await sheet.locator('h1.sheet-title').innerText()).toBe('Create shortcut')
    expect(await sheet.locator('.origin').innerText()).toBe(origin)
    const name = sheet.locator('input.text')
    expect(await name.inputValue()).toBe(TITLE)
    expect(await sheet.locator('.check').isHidden()).toBe(true)
    expect(await sheet.evaluate(() => document.activeElement?.tagName)).toBe('INPUT')
    await shoot(app, sheet, 'shortcut-sheet')

    await name.fill('My "fixture"\\n %f')
    await name.press('Enter')
    const banner = sheet.locator('.banner.ok')
    await banner.waitFor({ timeout: 10_000 })
    expect(await banner.innerText()).toBe(WINDOWS ? 'Shortcut added to your desktop.' : 'Shortcut added to your applications menu.')
    await shoot(app, sheet, 'shortcut-sheet-done')

    const files = written(data, desktop)
    expect(files).toHaveLength(1)
    if (WINDOWS) {
      // A .lnk on the desktop: the program, then the address as the last quoted argument; no profile flag for the default profile.
      expect(files[0]).toMatch(/\.lnk$/)
      const [link] = await readLinks(app, desktop) as [Link]
      expect(samePath(link.target, await app.evaluate(() => process.execPath))).toBe(true)
      expect(link.args.endsWith(` "${address}"`)).toBe(true)
      expect(link.args).not.toContain('--orivon-profile')
      expect(link.description).toBe('My "fixture"\\n %f')
    } else {
      expect(files[0]).toMatch(/^orivon-127-0-0-1-[0-9a-f]{8}\.desktop$/)
      const text = readFileSync(join(data, 'applications', files[0] as string), 'utf8')
      const lines = text.split('\n')
      expect(lines[0]).toBe('[Desktop Entry]')
      expect(lines.filter((line) => line.startsWith('Exec='))).toHaveLength(1)
      expect(lines.filter((line) => line.startsWith('Name='))).toEqual(['Name=My "fixture"\\\\n %f'])
      const exec = lines.find((line) => line.startsWith('Exec=')) as string
      // The address is the last argument, quoted, with its `$` and `%` escaped.
      expect(exec.endsWith(' "' + address.replace('$', '\\\\$').replace('%f', '%%f') + '"')).toBe(true)
      expect(text).toContain('Icon=orivon\n')
      expect(text).toContain('Categories=Network;WebBrowser;\n')
      expect(text.split('\n').every((line) => line === '' || line.startsWith('[') || /^[A-Za-z]+=/.test(line))).toBe(true)
    }

    // Done closes the sheet; a folder that cannot be made is reported, and nothing else is written.
    await sheet.getByRole('button', { name: 'Done' }).click()
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=shortcut-sheet')))).toBe(true)
    if (WINDOWS) {
      // A desktop that sits under a file cannot take a link.
      const blocker = join(desktop, files[0] as string)
      await redirectDesktop(app, join(blocker, 'not-a-directory'))
    } else {
      await app.evaluate(() => { process.env['XDG_DATA_HOME'] = '/dev/null/orivon-not-a-directory' })
    }
    await runCommand(chrome, 'site.shortcut')
    const failing = await waitSheet(app)
    await failing.locator('input.text').press('Enter')
    const error = failing.locator('.banner.error')
    await error.waitFor({ timeout: 10_000 })
    expect(await error.innerText()).toBe('Could not create the shortcut. Check that the folder can be written to.')
    await shoot(app, failing, 'shortcut-sheet-error')
    expect(written(data, desktop)).toEqual(files)

    // Escape cancels.
    await failing.keyboard.press('Escape').catch(() => {})
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=shortcut-sheet')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(!MAC)('has no site shortcut on macOS: the row is greyed with the reason and the command opens no sheet', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, `${origin}/mac`)
    await runCommand(chrome, 'site.shortcut')
    await delay(ABSENCE_SETTLE_MS)
    expect(await popoverShown(app, 'overlay=shortcut-sheet')).toBe(false)

    const menu = await menuSubmenu(app, chrome, 'More tools')
    const row = menu.getByRole('menuitem', { name: /^Create shortcut/ })
    expect(await row.getAttribute('aria-disabled')).toBe('true')
    expect(await row.innerText()).toContain('Not available on macOS')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(MAC)('offers to open the shortcut in this profile when it is not the default one, and names the profile only when that stays ticked', async () => {
  const data = scratchDir('xdg-profile')
  const desktop = scratchDir('desktop-profile')
  const { app, chrome } = await launched({
    args: [`--orivon-profile=${PROFILE}`],
    env: { XDG_DATA_HOME: data },
    seed: (dir) => {
      mkdirSync(join(dir, 'profiles', PROFILE), { recursive: true })
      writeFileSync(join(dir, 'profiles', PROFILE, 'profile.json'), JSON.stringify({ version: 1, name: 'Work', color: 'green', created: 1 }))
    }
  })
  try {
    if (WINDOWS) await redirectDesktop(app, desktop)
    await visit(chrome, `${origin}/profile`)
    await runCommand(chrome, 'site.shortcut')
    const sheet = await waitSheet(app)
    const tick = sheet.locator('.check input')
    expect(await sheet.locator('.check').innerText()).toBe('Open in this profile')
    expect(await tick.isChecked()).toBe(true)
    await shoot(app, sheet, 'shortcut-sheet-profile')
    await sheet.getByRole('button', { name: 'Create' }).click()
    await sheet.locator('.banner.ok').waitFor({ timeout: 10_000 })
    await sheet.getByRole('button', { name: 'Done' }).click()
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=shortcut-sheet')))).toBe(true)

    await runCommand(chrome, 'site.shortcut')
    const second = await waitSheet(app)
    await second.locator('.check input').uncheck()
    await second.getByRole('button', { name: 'Create' }).click()
    await second.locator('.banner.ok').waitFor({ timeout: 10_000 })

    // What each shortcut starts Orivon with: a desktop entry's whole text on Linux, a link's argument string on Windows.
    const launches = WINDOWS
      ? (await readLinks(app, desktop)).map((link) => link.args)
      : entries(data).map((file) => readFileSync(join(data, 'applications', file), 'utf8'))
    expect(launches).toHaveLength(2)
    expect(launches.filter((text) => text.includes(`"--orivon-profile=${PROFILE}" "${origin}/profile"`))).toHaveLength(1)
    expect(launches.filter((text) => !text.includes('--orivon-profile'))).toHaveLength(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('leaves a private window out of it: no default-browser row, no shortcut, and the menu says why', async () => {
  const data = scratchDir('xdg-private')
  const desktop = scratchDir('desktop-private')
  const { app, chrome } = await launched({ args: ['--orivon-private'], env: { XDG_DATA_HOME: data } })
  try {
    if (WINDOWS) await redirectDesktop(app, desktop)
    await stubSystem(app)
    await visit(chrome, `${origin}/private`)
    await runCommand(chrome, 'site.shortcut')
    await delay(ABSENCE_SETTLE_MS)
    expect(await popoverShown(app, 'overlay=shortcut-sheet')).toBe(false)
    expect(written(data, desktop)).toEqual([])

    const menu = await menuSubmenu(app, chrome, 'More tools')
    const row = menu.getByRole('menuitem', { name: /^Create shortcut/ })
    expect(await row.getAttribute('aria-disabled')).toBe('true')
    // macOS has no site shortcut at all, and that reason is the one the row gives.
    expect(await row.innerText()).toContain(MAC ? 'Not available on macOS' : 'Not available in a private window')
    await shoot(app, menu, 'menu-shortcut-private')
    await menu.keyboard.press('Escape').catch(() => {})

    const page = await openSettings(app, chrome, '/about')
    await page.waitForSelector('#row-about-version')
    expect(await page.locator('#row-default-browser').count()).toBe(0)
    expect(await page.locator('.nav-list').innerText()).not.toContain('Default browser')
    expect((await recorded(app)).setDefault).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
