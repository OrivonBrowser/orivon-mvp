// Optional permissions end to end. An extension page in a real tab asks with a
// real click: the sheet names the extension and the access in words, Escape
// refuses, Allow (after its guard) grants, the grant shows on the details page
// and survives a relaunch, Remove takes it back, and an undeclared permission is
// refused with no sheet at all. Set ORIVON_SHOTS_DIR to also write screenshots
// of each surface in both colour schemes.
//
// Run with `npm run test:e2e`, or through scripts/run-headless.mjs with
// test/vitest.e2e.config.ts after scripts/build-e2e.mjs.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from './smoke-helpers.mjs'
import { navigateToFixture } from './e2e-helpers.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 180_000
const SHOTS = process.env['ORIVON_SHOTS_DIR']
const SWEEP_NAME = 'Orivon E2E API Sweep'

interface ChromePermissions {
  request: (request: object) => Promise<boolean>
  contains: (request: object) => Promise<boolean>
  getAll: () => Promise<{ permissions: string[], origins: string[] }>
}
type Answer = { ok: boolean } | { error: string }
type ExtensionPage = Window & { __answer?: Answer | undefined, chrome: { permissions: ChromePermissions } }
interface Granted { permissions: string[], origins: string[] }

const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startFixtureServer (): Promise<string> {
  const created = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>permissions-fixture</title><body>fixture</body>')
  })
  servers.push(created)
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}/`
}

async function launched (seed: string[], reuseProfile?: string): Promise<{ app: ElectronApplication, ids: Map<string, string> }> {
  const ids = new Map<string, string>()
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    ...(reuseProfile === undefined ? { seedProfile: async (dir: string) => { for (const name of seed) ids.set(name, seedFixture(dir, name)) } } : { reuseProfile }),
    sandbox: true
  })
  expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === seed.length)).toBe(true)
  await waitRecovered(app)
  return { app, ids }
}

const overlayPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=extension-permission'))
const sheetShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=extension-permission')

/** A real click in the tab (the page's user activation), then the call, left pending in the page. */
async function ask (view: Page, request: object): Promise<void> {
  await view.mouse.click(60, 60)
  await view.evaluate((body: object) => {
    const page = window as unknown as ExtensionPage
    page.__answer = undefined
    page.chrome.permissions.request(body).then(
      (ok) => { page.__answer = { ok } },
      (error: Error) => { page.__answer = { error: error.message } })
  }, request)
}

async function answerOf (view: Page, timeoutMs = 8_000): Promise<Answer> {
  let answer: Answer | undefined
  const arrived = await waitFor(async () => {
    answer = await evaluateRetrying(view, () => (window as unknown as ExtensionPage).__answer)
    return answer !== undefined
  }, timeoutMs)
  expect(arrived).toBe(true)
  return answer as Answer
}

async function contains (view: Page, request: object): Promise<boolean> {
  return await view.evaluate(async (body: object) => await (window as unknown as ExtensionPage).chrome.permissions.contains(body), request)
}

async function shootPage (page: Page, name: string, selector?: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(350)
    const path = join(SHOTS, `${name}-${scheme}.png`)
    if (selector === undefined) await page.screenshot({ path })
    else await page.locator(selector).screenshot({ path })
  }
  await page.emulateMedia({ colorScheme: null })
}

async function openSheet (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(async () => await sheetShown(app) && overlayPage(app) !== undefined)).toBe(true)
  const sheet = overlayPage(app) as Page
  await sheet.waitForSelector('.perm .btn-row')
  return sheet
}

function grantedOf (userData: string): Granted | undefined {
  try {
    const file = JSON.parse(readFileSync(join(userData, 'extensions', 'prefs.json'), 'utf8')) as { extensions: Record<string, { granted?: Granted }> }
    return Object.values(file.extensions)[0]?.granted
  } catch {
    return undefined
  }
}

async function openDetails (app: ElectronApplication): Promise<Page> {
  const chrome = findChrome(app)
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (command: string) => void } }).orivonShell.runCommand('extensions.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://extensions')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://extensions')) as Page
  await page.waitForSelector('.ext-card')
  await page.locator('.ext-card a.link-btn', { hasText: 'Details' }).click()
  await page.waitForSelector('#section-optional')
  return page
}

it('asks, refuses on Escape, grants on Allow, shows it on the details page, takes it back, and keeps a grant across a relaunch', async () => {
  const fixtureUrl = await startFixtureServer()
  let { app, ids } = await launched(['api-sweep'])
  const id = ids.get('api-sweep') as string
  const extensionUrl = `chrome-extension://${id}/page.html`
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  let relaunched = false
  try {
    const view = await navigateToFixture(app, fixtureUrl, 'permissions-fixture')
    await view.goto(extensionUrl)
    expect(await evaluateRetrying(view, () => typeof (window as unknown as ExtensionPage).chrome?.permissions?.request)).toBe('function')

    // A permission the manifest never declared is refused outright, with no sheet.
    await ask(view, { permissions: ['geolocation'] })
    expect(await answerOf(view)).toEqual({ error: 'Only permissions specified in the manifest may be requested.' })
    await delay(600)
    expect(await sheetShown(app)).toBe(false)

    // A service worker has no user gesture, so its call is refused and no sheet appears.
    const hidden = await openExtensionPage(app, id, 'page.html')
    const fromWorker = await rpc(app, hidden, 'chrome.permissions.request', [{ permissions: ['history'] }])
    expect(JSON.stringify(fromWorker)).toContain('user gesture')
    expect(await sheetShown(app)).toBe(false)
    await app.evaluate(({ BrowserWindow }, prefix: string) => {
      for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().startsWith(prefix)) win.destroy()
    }, `chrome-extension://${id}/`)

    // The sheet names the extension, its id and the access in words; Escape refuses.
    await ask(view, { permissions: ['history'] })
    let sheet = await openSheet(app)
    expect(await sheet.locator('.sheet-title').textContent()).toBe(`Allow the extension "${SWEEP_NAME}" to do more?`)
    expect(await sheet.locator('.perm-id').textContent()).toContain(id.slice(0, 12))
    expect(await sheet.locator('.perm-lines li').allTextContents()).toEqual(['Read and change your browsing history'])
    expect(await sheet.evaluate(() => document.activeElement?.textContent)).toBe('Deny')
    expect(await sheet.locator('.btn.primary').isDisabled()).toBe(true)
    await delay(700)
    expect(await sheet.locator('.btn.primary').isDisabled()).toBe(false)
    await shootPage(sheet, 'sheet-one-line')
    await sheet.keyboard.press('Escape').catch(() => {})
    expect(await answerOf(view)).toEqual({ ok: false })
    expect(await contains(view, { permissions: ['history'] })).toBe(false)
    expect(await waitFor(async () => !(await sheetShown(app)))).toBe(true)

    // Allow, after the guard, grants, and the grant is on disk.
    await ask(view, { permissions: ['history'] })
    sheet = await openSheet(app)
    await delay(700)
    await sheet.click('.btn.primary')
    expect(await answerOf(view)).toEqual({ ok: true })
    expect(await contains(view, { permissions: ['history'] })).toBe(true)
    const all = await view.evaluate(async () => await (window as unknown as ExtensionPage).chrome.permissions.getAll())
    expect(all.permissions).toContain('history')
    expect(await waitFor(() => grantedOf(userData)?.permissions.includes('history') === true)).toBe(true)
    expect(await waitFor(async () => !(await sheetShown(app)))).toBe(true)

    // The details page lists it, and Remove takes it back.
    const page = await openDetails(app)
    expect(await page.locator('#section-optional h2').textContent()).toBe('Extra access you allowed')
    expect(await page.locator('#section-optional .grant-row').allTextContents()).toEqual(['Read and change your browsing historyRemove'])
    expect(await page.locator('#section-optional .stripped-list li').allTextContents()).toEqual(['Read and change your bookmarks'])
    await page.mouse.move(2, 2)
    await shootPage(page, 'details-granted', '#section-optional')
    await page.locator('#section-optional .grant-row .btn').click()
    await page.waitForSelector('#section-optional .grant-empty')
    expect(await page.locator('#section-optional .grant-empty').textContent()).toBe('Nothing extra yet. The extension will ask when it needs to.')
    expect(await page.locator('#section-optional .stripped-list li').allTextContents()).toEqual(['Read and change your bookmarks', 'Read and change your browsing history'])
    await page.mouse.move(2, 2)
    await shootPage(page, 'details-empty', '#section-optional')
    expect(await waitFor(() => (grantedOf(userData)?.permissions.length ?? 0) === 0)).toBe(true)
    expect(await contains(view, { permissions: ['history'] })).toBe(false)

    // A grant survives a relaunch: ask again, allow, quit, start on the same profile.
    await findChrome(app).locator('.tab').first().click()
    await waitFor(async () => (await view.evaluate(() => document.visibilityState)) === 'visible')
    await ask(view, { permissions: ['history'] })
    sheet = await openSheet(app)
    await delay(700)
    await sheet.click('.btn.primary')
    expect(await answerOf(view)).toEqual({ ok: true })
    expect(await waitFor(() => grantedOf(userData)?.permissions.includes('history') === true)).toBe(true)
    await view.goto(fixtureUrl)
    // With no page of the extension open, the quiet apply puts the grant into the manifest it loads.
    expect(await waitFor(async () => await app.evaluate(({ session }) =>
      (session.defaultSession.extensions.getAllExtensions()[0]?.manifest as { permissions?: string[] } | undefined)?.permissions?.includes('history') === true), 40_000)).toBe(true)

    await closeElectron(app, { keepProfile: true })
    relaunched = true
    ;({ app } = await launched(['api-sweep'], userData))
    const again = await navigateToFixture(app, fixtureUrl, 'permissions-fixture')
    await again.goto(extensionUrl)
    expect(await contains(again, { permissions: ['history'] })).toBe(true)
  } finally {
    await closeElectron(app)
    if (relaunched) rmSync(userData, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('shows a long list and a long name in the sheet, and the empty section before any grant', async () => {
  const fixtureUrl = await startFixtureServer()
  const { app, ids } = await launched(['optional-perms'])
  const id = ids.get('optional-perms') as string
  try {
    const view = await navigateToFixture(app, fixtureUrl, 'permissions-fixture')
    await view.goto(`chrome-extension://${id}/page.html`)
    await ask(view, {
      permissions: ['bookmarks', 'history', 'topSites', 'downloads', 'sessions', 'tabGroups', 'notifications'],
      origins: ['https://a.example.com/*', 'https://other.test/*']
    })
    const sheet = await openSheet(app)
    const title = (await sheet.locator('.sheet-title').textContent()) ?? ''
    expect(title).toBe('Allow the extension "Orivon E2E Optional Permissions With A…" to do more?')
    expect(await sheet.locator('.perm-lines li').count()).toBe(9)
    expect(await sheet.locator('.perm-lines').evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 160)).toBe(true)
    await delay(700)
    await shootPage(sheet, 'sheet-long')
    await sheet.click('.btn:not(.primary)')
    expect(await answerOf(view)).toEqual({ ok: false })

    const page = await openDetails(app)
    await page.waitForSelector('#section-optional .grant-empty')
    expect(await page.locator('#section-optional .grant-row').count()).toBe(0)
    await page.mouse.move(2, 2)
    await shootPage(page, 'details-empty-long', '#section-optional')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
