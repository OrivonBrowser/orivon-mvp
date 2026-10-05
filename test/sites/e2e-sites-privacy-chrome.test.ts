// The sites-and-privacy packet's lanes meet on one toolbar and one main menu: a page that has been refused the
// camera and also has a sign-in form wears the site-access chip, the password key, the zoom chip and the Web3
// mark in the address bar at once, and none may overlap or push the address out. The main menu lists the
// commands whose lane landed (Share, Passwords, and Clear browsing data under More tools).
// Set ORIVON_UI_SHOTS_DIR to also write screenshots of the toolbar and menu in both colour schemes.
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFakeKeyring } from '../../src/main/passwords/dev-password-storage.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { html, startServer } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { delay, findChrome, findViewShowing, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 180_000
const PAGE = `<!doctype html><title>Sign in</title><body style="font:16px sans-serif"><button id="cam">cam</button>
<form id="f" method="post" action="/welcome"><input id="user" name="user" type="text" autocomplete="username" style="display:block;margin:12px;width:260px">
<input id="pass" name="pass" type="password" autocomplete="current-password" style="display:block;margin:12px;width:260px">
<button type="submit" style="margin:12px">Sign in</button></form>
<script>document.getElementById('cam').addEventListener('click', () => { navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {}) })</script></body>`

let site: FixtureServer
beforeAll(async () => { site = await startServer((_request, response) => { html(response, PAGE) }) })
afterAll(async () => {
  await site.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

async function seedLogin (dir: string): Promise<void> {
  const secret = (await createFakeKeyring().encryptStringAsync('correct-horse-7')).toString('base64')
  await writeFile(join(dir, 'passwords.json'), JSON.stringify({ version: 1, logins: [{ id: 'l1', origin: site.origin, username: 'ada', secret, created: 1_700_000_000_000, used: 0 }], never: [] }))
}

interface Box { id: string, x: number, y: number, width: number, height: number }

/** Every visible control of the toolbar, with its box. */
const toolbarBoxes = async (chrome: Page): Promise<Box[]> => await chrome.evaluate(() => {
  const visible = (el: Element): boolean => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !(el as HTMLElement).hidden }
  return [...document.querySelectorAll('#toolbar button, #toolbar input, #toolbar .web3-mark')]
    .filter(visible)
    .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, x: r.x, y: r.y, width: r.width, height: r.height } })
})

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5

async function shootBoth (app: App, chrome: Page, name: string, target: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
    await chrome.emulateMedia({ colorScheme: scheme })
    await target.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await target.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
}

async function openMenu (app: App, chrome: Page): Promise<Page> {
  await chrome.click('#menu')
  expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
  expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=menu')))).toBe(true)
  const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
  await menu.waitForSelector('.menu-row')
  return menu
}

it('wears the permission chip, the password key, the zoom chip and the Web3 mark side by side, and lists only landed commands in the menu', async () => {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, '--use-fake-device-for-media-stream'],
    env: { ORIVON_TEST_PASSWORD_KEYRING: '1' },
    seedProfile: seedLogin
  })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await chrome.fill('#address', `${site.origin}/`)
    await chrome.press('#address', 'Enter')
    expect(await waitFor(() => findViewShowing(app, chrome, `${site.origin}/`) !== undefined)).toBe(true)
    const view = findViewShowing(app, chrome, `${site.origin}/`) as Page
    await view.waitForLoadState('load')

    // Refuse the camera: the chip appears.
    await view.click('#cam')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=site-prompt'), 15_000)).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()))).toBe(true)
    const prompt = app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1) as Page
    await prompt.waitForSelector('.site-prompt:not(.arming)')
    await prompt.click('.btn-row .btn:text-is("Block")').catch(() => {})
    const chip = async (): Promise<boolean> => await chrome.evaluate(() => { const el = document.querySelector<HTMLElement>('#site-access-chip'); return el !== null && !el.hidden })
    expect(await waitFor(chip)).toBe(true)

    // A user touch of the sign-in form shows the password key (a saved login exists for the origin).
    await view.click('#user')
    const key = async (): Promise<boolean> => await chrome.evaluate(() => { const el = document.querySelector<HTMLElement>('#password-key'); return el !== null && !el.hidden })
    expect(await waitFor(key)).toBe(true)

    // The zoom chip joins them.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('zoom.in') })
    expect(await waitFor(async () => await chrome.evaluate(() => { const el = document.querySelector<HTMLElement>('#zoom-chip'); return el !== null && !el.hidden }))).toBe(true)
    await delay(500)

    const boxes = await toolbarBoxes(chrome)
    const ids = boxes.map((box) => box.id)
    expect(ids).toEqual(expect.arrayContaining(['site-access-chip', 'password-key', 'zoom-chip', 'address']))
    const viewport = await chrome.evaluate(() => window.innerWidth)
    for (const box of boxes) expect(box.x + box.width, `${box.id} stays inside the window`).toBeLessThanOrEqual(viewport + 0.5)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as Box
        const b = boxes[j] as Box
        // The address input sits under the pill's own buttons by design only where they are not drawn over it.
        if (a.id === 'address' || b.id === 'address') continue
        expect(overlaps(a, b), `${a.id} and ${b.id} do not overlap`).toBe(false)
      }
    }
    const address = boxes.find((box) => box.id === 'address') as Box
    expect(address.width).toBeGreaterThan(200)
    // The chip and the key sit inside the address pill, to the right of the input, in the planned order.
    const x = (id: string): number => (boxes.find((box) => box.id === id) as Box).x
    expect(x('site-access-chip')).toBeGreaterThan(address.x)
    expect(x('password-key')).toBeGreaterThan(x('site-access-chip'))
    await shootBoth(app, chrome, 'chrome-all-marks', chrome)

    // The menu: what landed is listed; Clear browsing data sits under More tools, not at the top.
    const menu = await openMenu(app, chrome)
    const rows = (await menu.locator('.menu-row').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
    expect(rows.some((text) => text.startsWith('Passwords'))).toBe(true)
    expect(rows.some((text) => text.startsWith('Share'))).toBe(true)
    expect(rows.some((text) => text.startsWith('Clear browsing data'))).toBe(false)
    await shootBoth(app, chrome, 'menu-top', menu)
    await menu.locator('.menu-row', { hasText: 'More tools' }).click()
    await menu.locator('.menu-back').waitFor()
    const more = (await menu.locator('.menu-row').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
    expect(more.some((text) => text.startsWith('Create shortcut'))).toBe(true)
    expect(more.some((text) => text.startsWith('View certificate'))).toBe(true)
    expect(more.some((text) => text.startsWith('Clear browsing data'))).toBe(true)
    await shootBoth(app, chrome, 'menu-more-tools', menu)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
