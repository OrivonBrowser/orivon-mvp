// What a site may do, changed from two places: the site-info popover for the site in front of you and the Site
// settings section for every site with an answer of its own. A camera answered in the prompt shows in the popover,
// changes there (with the reload banner), is refused after the reload without asking, appears in Settings with its
// badge, goes back to "ask" from an opened row, and a default of Block refuses a new site outright. "Add a
// permission" sets a kind that was never asked, Clear browsing data forgets every answer when its box is ticked,
// and a private window keeps them in memory and says so. Fake devices only; no native dialog may be asked for.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-site-settings.test.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { html, launchShell, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { delay, popoverShown, waitFor } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 240_000
const FAKE_DEVICES = '--use-fake-device-for-media-stream'

const PAGE = `<!doctype html><title>site settings</title><body style="font:16px sans-serif">
<button id="cam">cam</button><button id="geo">geo</button>
<script>
window.__r = {}
const done = (key, promise) => promise.then((value) => { window.__r[key] = value }, (error) => { window.__r[key] = 'ERR:' + error.name })
const on = (id, run) => document.getElementById(id).addEventListener('click', run)
on('cam', () => done('cam', navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => stream.getTracks().map((t) => t.readyState).join(','))))
on('geo', () => done('geo', new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('position'), (e) => resolve('code' + e.code)))))
</script></body>`

const servers: FixtureServer[] = []
const origins: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' }

beforeAll(async () => {
  for (const key of ['a', 'b', 'c'] as const) {
    const server = await startServer((_request, response) => { html(response, PAGE) })
    servers.push(server)
    origins[key] = server.origin
  }
})

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

/** A plain http site is shown as such: only https is the expected case and is left off. */
const hostOf = (origin: string): string => origin.replace(/^https:\/\//, '')
const promptPage = (app: App): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1)
const promptShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=site-prompt')
const infoPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())
const settingsPage = (app: App): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://settings') && !w.isClosed())

async function waitPrompt (app: App): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    if (!(await promptShown(app))) return false
    const candidate = promptPage(app)
    if (candidate === undefined) return false
    try {
      await candidate.waitForSelector('.site-prompt .btn-row', { timeout: 2_000 })
      found = candidate
      return true
    } catch {
      return false
    }
  }, 15_000)
  expect(ok).toBe(true)
  return found as Page
}

/** Waits out the half second the buttons ignore presses, then presses one. */
async function answer (page: Page, label: 'Allow' | 'Block'): Promise<void> {
  await page.waitForSelector('.site-prompt:not(.arming)')
  try { await page.click(`.btn-row .btn:text-is("${label}")`) } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
}

const result = async (view: Page, key: string): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key); return last !== undefined }, 12_000)
  return last
}
const clear = async (view: Page, key: string): Promise<void> => { await view.evaluate((k) => { delete (window as unknown as { __r: Record<string, unknown> }).__r[k] }, key) }

async function waitChip (chrome: Page, hidden: boolean, label?: string): Promise<void> {
  let last = { hidden: true, label: '' }
  const ok = await waitFor(async () => {
    last = await chrome.evaluate(() => {
      const chip = document.querySelector<HTMLButtonElement>('#site-access-chip')
      return { hidden: chip === null || chip.hidden === true, label: chip?.getAttribute('aria-label') ?? '' }
    })
    return last.hidden === hidden && (label === undefined || last.label === label)
  })
  expect({ ok, last }).toEqual({ ok: true, last })
}

async function stubDialogs (app: App): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dialogs: string[] }
    g.__dialogs = []
    for (const name of ['showMessageBox', 'showOpenDialog', 'showSaveDialog', 'showErrorBox'] as const) {
      ;(dialog as unknown as Record<string, unknown>)[name] = async () => { g.__dialogs.push(name); return { response: 2, canceled: true, filePaths: [] } }
    }
  })
}

async function setScheme (app: App, pages: Array<Page | undefined>, scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  for (const page of pages) if (page !== undefined && !page.isClosed()) await page.emulateMedia({ colorScheme: scheme })
  await delay(400)
}

/** One page in both colour schemes. */
async function shootBoth (app: App, name: string, page: Page, selector?: string, ...others: Page[]): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(app, [page, ...others], scheme)
    const path = join(SHOTS_DIR, `${name}-${scheme}.png`)
    if (selector === undefined) await page.screenshot({ path })
    else await page.locator(selector).screenshot({ path })
  }
  await setScheme(app, [page, ...others], 'light')
}

/** The whole screen, for what a view's own screenshot cannot hold: a native select's list. */
function shootScreen (name: string): void {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  try { execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}.png`)]) } catch { /* no screenshot tool: the shot is optional */ }
}

/** The key under the address bar opens the popover; the same key closes it. */
async function openInfo (app: App, chrome: Page): Promise<Page> {
  await chrome.click('#site-permissions-btn')
  expect(await waitFor(() => infoPage(app) !== undefined, 8_000)).toBe(true)
  const popup = infoPage(app) as Page
  await popup.waitForSelector('.permissions')
  return popup
}

async function closeInfo (app: App, chrome: Page): Promise<void> {
  const popup = infoPage(app)
  if (popup === undefined) return
  await chrome.click('#site-permissions-btn')
  expect(await waitFor(() => infoPage(app) === undefined, 8_000)).toBe(true)
}

const textOf = async (page: Page, selector: string): Promise<string[]> => await page.locator(selector).allTextContents()
const rowsOf = async (popup: Page): Promise<string[]> => await textOf(popup, '.permissions > .row-list:not(.more-list) .row-message')
const optionsOf = async (page: Page, selector: string): Promise<string[]> => await page.locator(`${selector} option`).allTextContents()

/** Opens Settings at Site settings through the command the prompt's link runs. */
async function openSettings (app: App, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('siteSettings.open') })
  expect(await waitFor(() => settingsPage(app) !== undefined)).toBe(true)
  const page = settingsPage(app) as Page
  await page.waitForSelector('#row-sites-list .sites-ul:not([aria-busy="true"])')
  return page
}

/** Brings the nth tab to the front: a view that is not in front cannot be clicked or painted. */
async function activateTab (chrome: Page, index: number): Promise<void> {
  await chrome.evaluate((i) => { document.querySelectorAll<HTMLElement>('.tab')[i]?.click() }, index)
  expect(await waitFor(async () => await chrome.evaluate((i) => document.querySelectorAll('.tab')[i]?.classList.contains('active') === true, index))).toBe(true)
}

const siteItems = async (page: Page): Promise<string[]> => await textOf(page, '#row-sites-list .site-host')

it('shows an answer in the popover, changes it there, lists it in Settings, forgets it from an opened row, and a default of Block refuses a new site', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await stubDialogs(app)
    const view = await visit(app, chrome, `${origins.a}/`)

    // The key shows on an ordinary site that has asked for nothing, and the popover says so.
    expect(await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null)).toBe(true)
    let popup = await openInfo(app, chrome)
    expect(await textOf(popup, '.permissions .empty-state')).toEqual(['This site has not asked for anything.'])
    expect(await rowsOf(popup)).toEqual([])
    expect(await textOf(popup, '.add-permission')).toEqual(['Add a permission…'])
    expect(await popup.locator('.nav-row:has(span:text-is("Site settings"))').count()).toBe(1)
    await shootBoth(app, 'popover-empty', popup)
    await closeInfo(app, chrome)

    // The camera is asked and allowed in the prompt.
    await view.click('#cam')
    await answer(await waitPrompt(app), 'Allow')
    expect(await result(view, 'cam')).toBe('live')

    // The popover lists the camera, reading Allow, and offers the default and the two answers.
    popup = await openInfo(app, chrome)
    expect(await rowsOf(popup)).toEqual(['Camera'])
    expect(await popup.locator('.perm-select[data-kind="camera"]').inputValue()).toBe('allow')
    expect(await optionsOf(popup, '.perm-select[data-kind="camera"]')).toEqual(['Ask (default)', 'Allow', 'Block'])
    expect(await popup.locator('.reload-banner').count()).toBe(0)
    await shootBoth(app, 'popover-camera-allowed', popup)

    // Its native list opens inside the popover's view: the screen shows the choices.
    await popup.click('.perm-select[data-kind="camera"]')
    await delay(600)
    shootScreen('popover-select-open')
    await popup.keyboard.press('Escape')

    // Changing it applies at once and offers the reload.
    await popup.selectOption('.perm-select[data-kind="camera"]', 'block')
    await popup.waitForSelector('.reload-banner')
    expect(await textOf(popup, '.reload-banner')).toEqual(['Reload to apply your changes.Reload'])
    expect(await popup.locator('.perm-select[data-kind="camera"]').inputValue()).toBe('block')
    await shootBoth(app, 'popover-camera-blocked', popup)
    await popup.click('.reload-banner .btn-primary')
    await view.waitForLoadState('load')
    expect(await waitFor(async () => { try { return (await view.evaluate(() => (window as unknown as { __r?: unknown }).__r)) !== undefined } catch { return false } })).toBe(true)

    // The page is refused after the reload without asking.
    await clear(view, 'cam')
    await view.click('#cam')
    expect(await result(view, 'cam')).toBe('ERR:NotAllowedError')
    await delay(1_200)
    expect(await promptShown(app)).toBe(false)
    await waitChip(chrome, false, 'Camera blocked on this page')

    // Settings lists the site with its badge, and the camera's default row.
    let settings = await openSettings(app, chrome)
    expect(settings.url()).toContain('/sites')
    expect(await siteItems(settings)).toEqual([hostOf(origins.a)])
    expect(await textOf(settings, '#row-sites-list .site-badges .badge')).toEqual(['Camera blocked'])
    expect(await settings.locator('#row-sites-list .site-badges .badge.danger').count()).toBe(1)
    expect(await settings.locator('#row-sites-camera select').inputValue()).toBe('ask')
    expect(await optionsOf(settings, '#row-sites-camera')).toEqual(['Ask first', 'Block'])
    expect(await optionsOf(settings, '#row-sites-notifications')).toEqual(['Ask first', 'Block'])
    expect(await textOf(settings, '.group-label')).toEqual(['Permissions', 'Content', 'Sites'])
    await shootBoth(app, 'settings-list', settings)
    await shootBoth(app, 'settings-sites-card', settings, '#row-sites-list')

    // An opened row shows every kind with the site's choice, editable in place; "Ask (default)" forgets the answer.
    await settings.click('#row-sites-list .site-toggle')
    await settings.waitForSelector('#row-sites-list .site-kinds')
    expect(await settings.locator('#row-sites-list .site-select').first().inputValue()).toBe('block')
    expect(await textOf(settings, '#row-sites-list .site-kind-label')).toContain('Notifications')
    await shootBoth(app, 'settings-expanded', settings, '#row-sites-list')
    await settings.selectOption('#row-sites-list .site-select >> nth=0', 'default')
    await settings.waitForSelector('#row-sites-list .empty-state')
    expect(await textOf(settings, '#row-sites-list .empty-state')).toEqual(['No site has its own settings yet. Choices you make when a site asks appear here.'])
    expect(await settings.locator('#row-sites-list .btn.danger').isHidden()).toBe(true)
    await shootBoth(app, 'settings-empty', settings, '#row-sites-list')

    // The next request asks again.
    await activateTab(chrome, 0)
    await clear(view, 'cam')
    await view.reload()
    await view.click('#cam')
    await answer(await waitPrompt(app), 'Allow')
    expect(await result(view, 'cam')).toBe('live')

    // The list is live: the answer given in the tab shows in the open Settings page.
    await activateTab(chrome, 1)
    await settings.waitForSelector('#row-sites-list .site-item')
    expect(await textOf(settings, '#row-sites-list .site-badges .badge')).toEqual(['Camera allowed'])

    // A default of Block refuses a new site outright, and the chip says so.
    await settings.selectOption('#row-sites-camera select', 'block')
    await activateTab(chrome, 0)
    const fresh = await visit(app, chrome, `${origins.b}/`)
    await fresh.click('#cam')
    expect(await result(fresh, 'cam')).toBe('ERR:NotAllowedError')
    await delay(1_200)
    expect(await promptShown(app)).toBe(false)
    await waitChip(chrome, false, 'Camera blocked on this page')

    // The row names the default and offers the one answer that overrides it.
    popup = await openInfo(app, chrome)
    expect(await optionsOf(popup, '.perm-select[data-kind="camera"]')).toEqual(['Block (default)', 'Allow'])
    await closeInfo(app, chrome)
    await activateTab(chrome, 1)
    await settings.selectOption('#row-sites-camera select', 'ask')

    expect(await app.evaluate(() => (globalThis as unknown as { __dialogs: string[] }).__dialogs)).toEqual([])
    expect(mainOutput(app)).not.toMatch(/\[site-asks\]/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('sets a kind the site never asked about from "Add a permission", lists it in Settings, resets one site and all sites, and Clear browsing data forgets them when ticked', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await visit(app, chrome, `${origins.a}/`)
    expect(await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null)).toBe(true)

    const popup = await openInfo(app, chrome)
    await popup.click('.add-permission')
    await popup.waitForSelector('.more-list')
    const kinds = await popup.locator('.more-list .perm-select').evaluateAll((selects) => selects.map((select) => (select as HTMLElement).dataset['kind']))
    expect(kinds).toEqual(['camera', 'microphone', 'location', 'clipboardRead', 'midi', 'idle', 'windowManagement', 'notifications', 'popups', 'javascript', 'images', 'sound', 'autoDownloads'])
    expect(await popup.locator('.add-permission').getAttribute('aria-expanded')).toBe('true')
    await shootBoth(app, 'popover-add-permission', popup)
    await popup.selectOption('.perm-select[data-kind="location"]', 'allow')
    await popup.selectOption('.perm-select[data-kind="notifications"]', 'block')
    await popup.waitForSelector('.reload-banner')
    // They are listed now, above "Add a permission", and the rest still wait behind it.
    expect(await rowsOf(popup)).toEqual(['Location', 'Notifications'])
    await closeInfo(app, chrome)

    // The file keeps the site settings answer; notifications keep their own file.
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    expect(await waitFor(() => existsSync(join(userData, 'site-settings.json')))).toBe(true)
    expect(await waitFor(() => { try { return JSON.stringify(JSON.parse(readFileSync(join(userData, 'site-settings.json'), 'utf8')).sites) === JSON.stringify({ [origins.a]: { location: 'allow' } }) } catch { return false } })).toBe(true)
    expect(JSON.parse(readFileSync(join(userData, 'notification-decisions.json'), 'utf8')).origins).toEqual({ [origins.a]: 'block' })

    // A second site, so a reset of one leaves the other.
    await visit(app, chrome, `${origins.b}/`)
    const second = await openInfo(app, chrome)
    await second.click('.add-permission')
    await second.selectOption('.perm-select[data-kind="microphone"]', 'allow')
    await second.waitForSelector('.reload-banner')
    await closeInfo(app, chrome)

    let settings = await openSettings(app, chrome)
    expect(await siteItems(settings)).toEqual([hostOf(origins.a), hostOf(origins.b)].sort())
    expect(await textOf(settings, `#row-sites-list .site-item[data-origin="${origins.a}"] .badge`)).toEqual(['Location allowed', 'Notifications blocked'])

    // Search narrows the list; no match says so.
    await settings.fill('#row-sites-list input[type="search"]', hostOf(origins.b))
    expect(await siteItems(settings)).toEqual([hostOf(origins.b)])
    await settings.fill('#row-sites-list input[type="search"]', 'nothing-like-this')
    expect(await textOf(settings, '#row-sites-list .empty-state')).toEqual(['No sites match "nothing-like-this".'])
    await settings.fill('#row-sites-list input[type="search"]', '')

    // Resetting a site takes two clicks and leaves the other.
    const resetOne = settings.locator(`#row-sites-list .site-item[data-origin="${origins.a}"] .btn.icon`)
    await resetOne.click()
    expect(await siteItems(settings)).toHaveLength(2)
    await settings.locator(`#row-sites-list .site-item[data-origin="${origins.a}"] .btn.danger.armed`).click()
    await settings.waitForFunction((origin) => document.querySelector(`#row-sites-list .site-item[data-origin="${origin}"]`) === null, origins.a)
    expect(await siteItems(settings)).toEqual([hostOf(origins.b)])
    expect(JSON.parse(readFileSync(join(userData, 'notification-decisions.json'), 'utf8')).origins).toEqual({})
    expect(await waitFor(() => { try { return JSON.stringify(JSON.parse(readFileSync(join(userData, 'site-settings.json'), 'utf8')).sites) === JSON.stringify({ [origins.b]: { microphone: 'allow' } }) } catch { return false } })).toBe(true)

    // Clear browsing data with the new box ticked empties the list; with it unticked it would not.
    await settings.click('#row-sites-list .btn.danger')
    await settings.click('#row-sites-list .btn.danger.armed')
    await settings.waitForSelector('#row-sites-list .empty-state')
    expect(await waitFor(() => { try { return Object.keys(JSON.parse(readFileSync(join(userData, 'site-settings.json'), 'utf8')).sites ?? {}).length === 0 } catch { return false } })).toBe(true)

    // Put an answer back and clear through the dialog.
    await visit(app, chrome, `${origins.c}/`)
    const third = await openInfo(app, chrome)
    await third.click('.add-permission')
    await third.selectOption('.perm-select[data-kind="idle"]', 'block')
    await third.waitForSelector('.reload-banner')
    await closeInfo(app, chrome)
    settings = await openSettings(app, chrome)
    await settings.click('a.nav-item:has-text("Privacy")')
    const option = settings.locator('.clear-option', { hasText: 'Site settings and permissions' })
    await option.waitFor()
    expect(await textOf(settings, '.clear-option >> text=Site settings and permissions')).toBeTruthy()
    expect(await option.locator('input').isChecked()).toBe(false)
    expect(await textOf(settings, '.clear-option .muted')).toContain('Forgets what you allowed or blocked for each site.')
    await settings.locator('.clear-history input').uncheck()
    await shootBoth(app, 'settings-clear-data', settings, '#row-clear-data')
    // Unticked: clearing something else leaves the answer.
    await settings.locator('.clear-option', { hasText: 'Saved zoom levels' }).locator('input').check()
    await settings.click('.clear-actions .btn.danger')
    await settings.click('.clear-actions .btn.danger.armed')
    await settings.waitForSelector('.clear-actions p:text-is("Cleared.")')
    expect(JSON.parse(readFileSync(join(userData, 'site-settings.json'), 'utf8')).sites).toEqual({ [origins.c]: { idle: 'block' } })
    await option.locator('input').check()
    await settings.click('.clear-actions .btn.danger')
    await settings.click('.clear-actions .btn.danger.armed')
    await settings.waitForFunction(() => Array.from(document.querySelectorAll('.clear-actions p')).some((p) => p.textContent === 'Cleared.'))
    expect(await waitFor(() => { try { return Object.keys(JSON.parse(readFileSync(join(userData, 'site-settings.json'), 'utf8')).sites ?? {}).length === 0 } catch { return false } })).toBe(true)
    await settings.click('a.nav-item:has-text("Site settings")')
    await settings.waitForSelector('#row-sites-list .empty-state')
    expect(mainOutput(app)).not.toMatch(/\[site-asks\]/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('opens the Site settings page from the popover\'s footer and from the all-sites panel\'s link', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${origins.a}/`)
    expect(await waitFor(async () => (await chrome.getAttribute('#site-permissions-btn', 'hidden')) === null)).toBe(true)

    // The popover's footer row: the popover gives way to the page, in a tab of its own.
    const popup = await openInfo(app, chrome)
    await popup.click('.nav-row:has(span:text-is("Site settings"))')
    expect(await waitFor(() => settingsPage(app) !== undefined)).toBe(true)
    expect(await waitFor(() => infoPage(app) === undefined)).toBe(true)
    expect((settingsPage(app) as Page).url()).toContain('/sites')

    // The all-sites panel: a link under its list.
    await activateTab(chrome, 0)
    await chrome.click('#permissions-btn')
    const panelOf = (): Page | undefined => app.windows().find((w) => w.url().endsWith('/renderer/permissions/index.html') && !w.isClosed())
    expect(await waitFor(() => panelOf() !== undefined)).toBe(true)
    const panel = panelOf() as Page
    await panel.waitForSelector('#site-settings-link')
    expect(await textOf(panel, '#site-settings-link')).toEqual(['All site settings'])
    await shootBoth(app, 'all-sites-link', panel)
    await panel.click('#site-settings-link')
    expect(await waitFor(() => panelOf() === undefined)).toBe(true)
    await activateTab(chrome, 1)
    expect((settingsPage(app) as Page).url()).toContain('/sites')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('keeps a private window\'s answers in memory and says so in the popover and in Settings', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private', FAKE_DEVICES] })
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    await view.click('#cam')
    await answer(await waitPrompt(app), 'Allow')
    expect(await result(view, 'cam')).toBe('live')

    const popup = await openInfo(app, chrome)
    expect(await rowsOf(popup)).toEqual(['Camera'])
    expect(await textOf(popup, '.permissions > .empty-state')).toEqual(['Forgotten when this private window closes.'])
    await shootBoth(app, 'popover-private', popup)
    await closeInfo(app, chrome)

    const settings = await openSettings(app, chrome)
    expect(await siteItems(settings)).toEqual([hostOf(origins.a)])
    expect(await textOf(settings, '#row-sites-list .banner')).toEqual(['Choices made in a private window are forgotten when it closes.'])
    await shootBoth(app, 'settings-private', settings, '#row-sites-list')
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    await delay(800)
    expect(existsSync(join(userData, 'site-settings.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
