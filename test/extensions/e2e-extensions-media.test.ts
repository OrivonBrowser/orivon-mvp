// An extension's own page asking for the camera or the microphone, end to end, on fake devices (never a real
// one). The person is asked in the window showing the page, once per extension; Allow and Block are kept per
// device, closing the sheet keeps nothing, the details page changes or resets an answer, Settings' default
// block refuses without a sheet, and a page with no visible place (an offscreen document, a hidden window) is
// never asked and gets only a stored answer. Set ORIVON_SHOTS_DIR to also write screenshots in both colour schemes.
//
// Run with `npm run test:e2e`, or through scripts/run-headless.mjs with
// test/vitest.e2e.config.ts after scripts/build-e2e.mjs.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'
import { navigateToFixture } from '../support/e2e-helpers.js'
import { closePopup, openExtensionPage, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 240_000
const SHOTS = process.env['ORIVON_SHOTS_DIR']
const FAKE_DEVICES = '--use-fake-device-for-media-stream'
const NAME = 'Orivon E2E Camera Page'

interface Outcome { ok: boolean, name?: string, tracks?: Array<{ kind: string, readyState: string }> }
type MediaPage = Window & { __ask: (constraints: object) => Promise<Outcome>, __media?: Outcome | undefined }
type Choice = 'allow' | 'block' | 'ask'

const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function startFixtureServer (): Promise<string> {
  const created = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>media-fixture</title><body>fixture</body>')
  })
  servers.push(created)
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}/`
}

async function launched (options: { reuseProfile?: string, settings?: Record<string, unknown> } = {}): Promise<{ app: ElectronApplication, id: string, userData: string }> {
  let id = ''
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, FAKE_DEVICES],
    ...(options.reuseProfile === undefined
      ? {
          seedProfile: async (dir: string) => {
            id = seedFixture(dir, 'media-page')
            if (options.settings !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: options.settings }))
          }
        }
      : { reuseProfile: options.reuseProfile }),
    sandbox: true
  })
  expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)).toBe(true)
  await waitRecovered(app)
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  return { app, id, userData }
}

const sheetPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=extension-permission'))
const sheetShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=extension-permission')

async function openSheet (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(async () => await sheetShown(app) && sheetPage(app) !== undefined)).toBe(true)
  const sheet = sheetPage(app) as Page
  await sheet.waitForSelector('.perm .btn-row')
  return sheet
}

async function expectNoSheet (app: ElectronApplication): Promise<void> {
  await delay(900)
  expect(await sheetShown(app)).toBe(false)
}

/** Starts the call and leaves it pending in the page: a question blocks it until the person answers. */
async function ask (page: Page, constraints: object): Promise<void> {
  await page.evaluate((body: object) => {
    const media = window as unknown as MediaPage
    media.__media = undefined
    void media.__ask(body)
  }, constraints)
}

async function outcomeOf (page: Page, timeoutMs = 10_000): Promise<Outcome> {
  let outcome: Outcome | undefined
  const arrived = await waitFor(async () => {
    outcome = await evaluateRetrying(page, () => (window as unknown as MediaPage).__media)
    return outcome !== undefined
  }, timeoutMs)
  expect(arrived).toBe(true)
  return outcome as Outcome
}

async function answerSheet (sheet: Page, button: 'Allow' | 'Block'): Promise<void> {
  await sheet.waitForFunction(() => document.querySelector<HTMLButtonElement>('.btn.primary')?.disabled === false)
  await sheet.click(`.btn-row .btn:text-is("${button}")`)
}

function storedMedia (userData: string): Record<string, string> | undefined {
  try {
    const file = JSON.parse(readFileSync(join(userData, 'extensions', 'prefs.json'), 'utf8')) as { extensions: Record<string, { media?: Record<string, string> }> }
    return Object.values(file.extensions)[0]?.media
  } catch {
    return undefined
  }
}

async function shoot (page: Page, name: string, selector?: string): Promise<void> {
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

async function openDetails (app: ElectronApplication): Promise<Page> {
  const chrome = findChrome(app)
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (command: string) => void } }).orivonShell.runCommand('extensions.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://extensions')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://extensions')) as Page
  await page.waitForSelector('.ext-card')
  await page.locator('.ext-card a.link-btn', { hasText: 'Details' }).click()
  await page.waitForSelector('#section-about')
  return page
}

async function setOnDetails (details: Page, kind: 'camera' | 'microphone', value: Choice): Promise<void> {
  await details.selectOption(`#media-${kind}`, value)
}

it('asks in the window showing an options page, keeps Allow and Block per device, and lets the details page change or reset them', async () => {
  const fixtureUrl = await startFixtureServer()
  const { app, id, userData } = await launched()
  const extensionUrl = `chrome-extension://${id}/page.html`
  try {
    const view = await navigateToFixture(app, fixtureUrl, 'media-fixture')
    await view.goto(extensionUrl)
    expect(await evaluateRetrying(view, () => typeof (window as unknown as MediaPage).__ask)).toBe('function')

    // Before any answer the page is told it has no camera access.
    expect(await view.evaluate(async () => (await navigator.permissions.query({ name: 'camera' as PermissionName })).state)).not.toBe('granted')

    // The sheet names the extension and the device; closing it keeps nothing and refuses this request.
    await ask(view, { video: true })
    let sheet = await openSheet(app)
    expect(await sheet.locator('.sheet-title').textContent()).toBe(`${NAME} wants to use your camera`)
    expect(await sheet.locator('.perm-id').textContent()).toBe(`Extension ID ${id}`)
    expect(await sheet.locator('.perm-lines').count()).toBe(0)
    expect(await sheet.locator('.btn-row .btn').allTextContents()).toEqual(['Block', 'Allow'])
    expect(await sheet.locator('.btn.primary').isDisabled()).toBe(true)
    await delay(700)
    await shoot(sheet, 'media-sheet-camera')
    await sheet.keyboard.press('Escape').catch(() => {})
    expect(await outcomeOf(view)).toEqual({ ok: false, name: 'NotAllowedError' })
    expect(await waitFor(async () => !(await sheetShown(app)))).toBe(true)
    expect(storedMedia(userData)).toBeUndefined()

    // Allow gives a live video track, and is kept.
    await ask(view, { video: true })
    sheet = await openSheet(app)
    await answerSheet(sheet, 'Allow')
    expect(await outcomeOf(view)).toEqual({ ok: true, tracks: [{ kind: 'video', readyState: 'live' }] })
    expect(await waitFor(() => storedMedia(userData)?.['camera'] === 'allow')).toBe(true)
    expect(await waitFor(async () => !(await sheetShown(app)))).toBe(true)

    // The next load is not asked, and the page's own checks agree with the answer.
    await view.goto(extensionUrl)
    expect(await evaluateRetrying(view, () => typeof (window as unknown as MediaPage).__ask)).toBe('function')
    await ask(view, { video: true })
    expect((await outcomeOf(view)).ok).toBe(true)
    await expectNoSheet(app)
    expect(await view.evaluate(async () => (await navigator.permissions.query({ name: 'camera' as PermissionName })).state)).toBe('granted')
    expect(await view.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state)).not.toBe('granted')

    // The microphone is a separate answer: Block refuses and is not asked about again.
    await ask(view, { audio: true })
    sheet = await openSheet(app)
    expect(await sheet.locator('.sheet-title').textContent()).toBe(`${NAME} wants to use your microphone`)
    await answerSheet(sheet, 'Block')
    expect(await outcomeOf(view)).toEqual({ ok: false, name: 'NotAllowedError' })
    expect(await waitFor(() => storedMedia(userData)?.['microphone'] === 'block')).toBe(true)
    await ask(view, { audio: true })
    expect(await outcomeOf(view)).toEqual({ ok: false, name: 'NotAllowedError' })
    await expectNoSheet(app)
    // One blocked device refuses a request for both, and the camera answer is untouched.
    await ask(view, { audio: true, video: true })
    expect(await outcomeOf(view)).toEqual({ ok: false, name: 'NotAllowedError' })
    expect(storedMedia(userData)).toEqual({ camera: 'allow', microphone: 'block' })

    // The details page shows both answers; Ask puts a device back to being asked.
    const details = await openDetails(app)
    await details.waitForSelector('#section-media')
    expect(await details.locator('#section-media h2').textContent()).toBe('Camera and microphone')
    expect(await details.locator('#media-camera').inputValue()).toBe('allow')
    expect(await details.locator('#media-microphone').inputValue()).toBe('block')
    await details.mouse.move(2, 2)
    await shoot(details, 'media-details', '#section-media')
    await setOnDetails(details, 'microphone', 'ask')
    await details.waitForFunction(() => document.querySelector('#media-microphone') === null)
    expect(await waitFor(() => storedMedia(userData)?.['microphone'] === undefined && storedMedia(userData)?.['camera'] === 'allow')).toBe(true)

    // Back in the tab: a request for both asks once, for the one not answered, and says so.
    await findChrome(app).locator('.tab').first().click()
    await waitFor(async () => (await view.evaluate(() => document.visibilityState)) === 'visible')
    await ask(view, { audio: true, video: true })
    sheet = await openSheet(app)
    expect(await sheet.locator('.sheet-title').textContent()).toBe(`${NAME} wants to use your microphone`)
    await answerSheet(sheet, 'Allow')
    expect(await outcomeOf(view)).toEqual({ ok: true, tracks: [{ kind: 'audio', readyState: 'live' }, { kind: 'video', readyState: 'live' }] })
    expect(await waitFor(() => storedMedia(userData)?.['microphone'] === 'allow')).toBe(true)

    // Blocked on the details page takes effect on the next request, with no sheet.
    await setOnDetails(details, 'camera', 'block')
    expect(await waitFor(() => storedMedia(userData)?.['camera'] === 'block')).toBe(true)
    await findChrome(app).locator('.tab').first().click()
    await waitFor(async () => (await view.evaluate(() => document.visibilityState)) === 'visible')
    await ask(view, { video: true })
    expect(await outcomeOf(view)).toEqual({ ok: false, name: 'NotAllowedError' })
    await expectNoSheet(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('asks for the camera and the microphone together, once, and keeps both', async () => {
  const fixtureUrl = await startFixtureServer()
  const { app, id, userData } = await launched()
  try {
    const view = await navigateToFixture(app, fixtureUrl, 'media-fixture')
    await view.goto(`chrome-extension://${id}/page.html`)
    expect(await evaluateRetrying(view, () => typeof (window as unknown as MediaPage).__ask)).toBe('function')
    await ask(view, { audio: true, video: true })
    const sheet = await openSheet(app)
    expect(await sheet.locator('.sheet-title').textContent()).toBe(`${NAME} wants to use your camera and microphone`)
    await delay(700)
    await shoot(sheet, 'media-sheet-both')
    await answerSheet(sheet, 'Allow')
    expect((await outcomeOf(view)).tracks?.map((track) => track.kind)).toEqual(['audio', 'video'])
    expect(await waitFor(() => storedMedia(userData)?.['camera'] === 'allow' && storedMedia(userData)?.['microphone'] === 'allow')).toBe(true)
    await expectNoSheet(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('refuses without a sheet where Settings blocks the device, and an offscreen document or a hidden window is never asked', async () => {
  const fixtureUrl = await startFixtureServer()
  const { app, id, userData } = await launched({ settings: { 'sites.microphone': 'block' } })
  try {
    const view = await navigateToFixture(app, fixtureUrl, 'media-fixture')
    await view.goto(`chrome-extension://${id}/page.html`)
    expect(await evaluateRetrying(view, () => typeof (window as unknown as MediaPage).__ask)).toBe('function')
    await ask(view, { audio: true })
    expect(await outcomeOf(view)).toEqual({ ok: false, name: 'NotAllowedError' })
    await expectNoSheet(app)
    expect(storedMedia(userData)).toBeUndefined()

    // A page in a window nobody can see is not asked, with the camera still undecided.
    const hidden = await openExtensionPage(app, id, 'page.html')
    const hiddenOutcome = await app.evaluate(async ({ webContents }, wc: number) =>
      await webContents.fromId(wc)?.executeJavaScript('window.__ask({ video: true })', true) as { ok: boolean, name?: string }, hidden)
    expect(hiddenOutcome).toEqual({ ok: false, name: 'NotAllowedError' })
    await expectNoSheet(app)

    // An offscreen document has no window either: refused with no answer stored, and allowed once the person has said yes elsewhere.
    const fromOffscreen = async (constraints: object): Promise<Outcome> => await app.evaluate(async ({ webContents }, [wc, body]: [number, string]) =>
      await webContents.fromId(wc)?.executeJavaScript(`chrome.runtime.sendMessage({ cmd: 'ask-offscreen', constraints: ${body} })`, true) as Outcome,
    [hidden, JSON.stringify(constraints)] as [number, string])
    expect(await fromOffscreen({ video: true })).toEqual({ ok: false, name: 'NotAllowedError' })
    await expectNoSheet(app)
    expect(storedMedia(userData)).toBeUndefined()

    await ask(view, { video: true })
    const sheet = await openSheet(app)
    await answerSheet(sheet, 'Allow')
    expect((await outcomeOf(view)).ok).toBe(true)
    expect(await fromOffscreen({ video: true })).toEqual({ ok: true, tracks: [{ kind: 'video', readyState: 'live' }] })
    // A device the person blocked in Settings stays refused for the offscreen document too.
    expect(await fromOffscreen({ audio: true })).toEqual({ ok: false, name: 'NotAllowedError' })
    await expectNoSheet(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps an answer given from an open popup, and a stored answer works from the popup the next time', async () => {
  const fixtureUrl = await startFixtureServer()
  const { app, id, userData } = await launched()
  const popupOf = (): Page | undefined => app.windows().find((w) => w.url().startsWith(`chrome-extension://${id}/popup.html`))
  const openPopup = async (): Promise<Page> => {
    const chrome = findChrome(app)
    const selector = `#${id}`
    await waitFor(async () => await chrome.evaluate((sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, selector), 8_000)
    await chrome.click(selector)
    expect(await waitFor(async () => popupOf() !== undefined, 8_000)).toBe(true)
    return popupOf() as Page
  }
  try {
    await navigateToFixture(app, fixtureUrl, 'media-fixture')
    let popup = await openPopup()
    await ask(popup, { video: true })
    const sheet = await openSheet(app)
    expect(await sheet.locator('.sheet-title').textContent()).toBe(`${NAME} wants to use your camera`)
    // Measured: the sheet takes the keyboard, so the popup closes (as it does for any click elsewhere) and the
    // call it was waiting on is lost. The answer is still kept, and the next time the popup asks it is not asked again.
    await answerSheet(sheet, 'Allow')
    expect(await waitFor(() => storedMedia(userData)?.['camera'] === 'allow')).toBe(true)
    await closePopup(app, id).catch(() => {})

    popup = await openPopup()
    await ask(popup, { video: true })
    expect((await outcomeOf(popup)).ok).toBe(true)
    await expectNoSheet(app)
  } finally {
    await closeElectron(app)
    rmSync(userData, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)
