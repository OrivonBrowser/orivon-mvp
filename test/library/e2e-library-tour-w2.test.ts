// A screenshot tour of the library surfaces that join the chrome in the second wave: the downloads button and its
// bubble, the bookmark bubble and all-tabs sheet, the Bookmarks submenu, the bookmark manager, the Import page and the
// Settings rows for engines and the downloads button, each in both colour schemes as a picture of the whole virtual
// screen. It asserts only that every surface opened; the pictures are what a reader looks at. Without
// ORIVON_UI_SHOTS_DIR it does nothing.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { clickLink, openInternalPage, removeDir, scratchDir, startServer, stubSystem, visitFiles } from './downloads-fixture.js'
import type { DownloadServer } from './downloads-fixture.js'
import { fakeHome, removeHome, runCommand } from './import-fixture.js'
import { delay, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const TEST_TIMEOUT_MS = 240_000

let server: DownloadServer
let dir = ''
let home = ''

beforeAll(async () => {
  server = await startServer()
  dir = await scratchDir('orivon-tour2-')
  home = await fakeHome()
  if (SHOTS_DIR !== undefined) mkdirSync(SHOTS_DIR, { recursive: true })
})

afterAll(async () => {
  await server.close()
  await removeDir(dir)
  await removeHome(home)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Node { id: string, kind: 'url' | 'folder', title: string, url?: string, added: number, children?: Node[] }
const url = (id: string, title: string, path = id): Node => ({ id, kind: 'url', title, url: `${server.origin}/${path}`, added: 1 })

async function seed (profile: string): Promise<void> {
  await mkdir(profile, { recursive: true })
  const work: Node = { id: 'work0000000', kind: 'folder', title: 'Work', added: 1, children: [url('w1', 'Design notes'), url('w2', 'Sprint board')] }
  const bar: Node[] = [work, url('b1', 'Files page', ''), url('b2', 'Release notes'), url('b3', 'Recipes')]
  const other: Node[] = [url('o1', 'Weekend reading'), { id: 'trips000000', kind: 'folder', title: 'Trips', added: 1, children: [url('t1', 'Rail map')] }]
  writeFileSync(join(profile, 'bookmarks.json'), JSON.stringify({ version: 2, roots: { bar, other, reading: [] } }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ version: 1, values: { 'downloads.folder': dir, 'toolbar.downloads': 'always', 'downloads.showBubble': false } }))
}

/** Puts every view of the app in `scheme`, then pictures the whole virtual screen under `name`. */
async function snap (app: ElectronApplication, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  for (const scheme of ['light', 'dark'] as const) {
    for (const win of app.windows()) await Promise.race([win.emulateMedia({ colorScheme: scheme }).catch(() => undefined), delay(3000)])
    await delay(500)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)], { timeout: 20_000 })
  }
  for (const win of app.windows()) await Promise.race([win.emulateMedia({ colorScheme: null }).catch(() => undefined), delay(3000)])
}

const park = async (chrome: Page): Promise<void> => { await chrome.mouse.move(700, 14); await delay(200) }

/** Escape goes to whichever view has the keys: an overlay that took focus, else the chrome. */
async function closeOverlay (app: ElectronApplication, chrome: Page): Promise<void> {
  const overlays = app.windows().filter((w) => w.url().includes('/overlay/') || w.url().includes('overlay='))
  for (const overlay of overlays) await overlay.keyboard.press('Escape').catch(() => undefined)
  await chrome.keyboard.press('Escape').catch(() => undefined)
  await delay(400)
}

it('pictures the chrome and each second-wave library surface together', async () => {
  if (SHOTS_DIR === undefined) return
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, '--alsa-output-device=null'],
    env: { PULSE_SERVER: 'unix:/nonexistent', ORIVON_TEST_IMPORT_HOME: home },
    seedProfile: seed
  })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await stubSystem(app, dir)
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(1280, 800) })
    const files = await visitFiles(app, chrome, server.origin)
    await park(chrome)
    await snap(app, '01-chrome-idle')

    await chrome.click('#bookmark-toggle')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=bookmark-edit'))).toBe(true)
    await delay(600)
    await snap(app, '02-star-bubble')
    await closeOverlay(app, chrome)

    await runCommand(chrome, 'bookmark.allTabs')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=bookmark-all-tabs'))).toBe(true)
    await delay(600)
    await snap(app, '03-all-tabs-sheet')
    await closeOverlay(app, chrome)

    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    await delay(500)
    const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
    await menu.click('[data-key="sub:Bookmarks"]')
    await delay(400)
    await snap(app, '04-menu-bookmarks')
    // Escape inside a submenu steps back to the list, which is worth a picture of its own.
    await closeOverlay(app, chrome)
    await snap(app, '04b-menu-root')
    await closeOverlay(app, chrome)

    await clickLink(files, '#slow')
    await clickLink(files, '#exe')
    await clickLink(files, '#file')
    await clickLink(files, '#half')
    await delay(1500)
    await park(chrome)
    await snap(app, '05-chrome-downloading')
    await chrome.click('#downloads')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=downloads&'))).toBe(true)
    await delay(700)
    await snap(app, '06-downloads-bubble')
    await closeOverlay(app, chrome)

    await openInternalPage(app, chrome, 'bookmarks')
    await park(chrome)
    await delay(600)
    await snap(app, '07-manager')

    await openInternalPage(app, chrome, 'import')
    await park(chrome)
    await delay(800)
    await snap(app, '08-import')

    const settings = await openInternalPage(app, chrome, 'settings', '/search')
    await park(chrome)
    await delay(500)
    await snap(app, '09-settings-search')
    await settings.evaluate(() => { for (const el of Array.from(document.querySelectorAll('*'))) if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = el.scrollHeight })
    await delay(400)
    await snap(app, '09b-settings-engines')

    await openInternalPage(app, chrome, 'settings', '/appearance')
    await park(chrome)
    await delay(500)
    await snap(app, '10-settings-appearance')

    await chrome.click('#address')
    await chrome.keyboard.press('ControlOrMeta+A')
    await chrome.keyboard.type('w solar', { delay: 40 })
    expect(await waitFor(async () => await popoverShown(app, 'overlay=omnibox'))).toBe(true)
    await delay(700)
    await snap(app, '11-omnibox-keyword')
    await closeOverlay(app, chrome)
    await closeOverlay(app, chrome)

    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(760, 800) })
    await delay(800)
    await park(chrome)
    await snap(app, '12-chrome-narrow')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
