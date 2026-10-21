// A screenshot tour of the library surfaces together: the chrome with the bookmarks bar, the address dropdown, a
// bar folder, the main menu, the QR sheet, and the Downloads, About, Task manager, History and Settings pages, each in
// both colour schemes as a picture of the whole virtual screen. It asserts only that every surface opened; the
// pictures are what a reader looks at. Without ORIVON_UI_SHOTS_DIR it does nothing.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SqliteHistoryStore } from '../../src/main/history/sqlite-history-store.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { clickLink, openInternalPage, removeDir, scratchDir, startServer, stubSystem, visitFiles } from './downloads-fixture.js'
import type { DownloadServer } from './downloads-fixture.js'
import { delay, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const TEST_TIMEOUT_MS = 180_000
const DAY = 24 * 60 * 60 * 1000

let server: DownloadServer
let dir = ''

beforeAll(async () => {
  server = await startServer()
  dir = await scratchDir('orivon-tour-')
  if (SHOTS_DIR !== undefined) mkdirSync(SHOTS_DIR, { recursive: true })
})

afterAll(async () => {
  await server.close()
  await removeDir(dir)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

interface Node { id: string, kind: 'url' | 'folder', title: string, url?: string, added: number, children?: Node[] }
const url = (id: string, title: string, path = id): Node => ({ id, kind: 'url', title, url: `${server.origin}/${path}`, added: 1 })

async function seed (profile: string): Promise<void> {
  await mkdir(profile, { recursive: true })
  const work: Node = { id: 'work0000000', kind: 'folder', title: 'Work', added: 1, children: [url('w1', 'Design notes'), url('w2', 'Sprint board')] }
  const bar: Node[] = [work, url('b1', 'Files page', ''), url('b2', 'Release notes'), url('b3', 'Reading'), { id: 'empty000000', kind: 'folder', title: 'Empty', added: 1, children: [] }]
  writeFileSync(join(profile, 'bookmarks.json'), JSON.stringify({ version: 2, roots: { bar, other: [], reading: [] } }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ version: 1, values: { 'downloads.folder': dir } }))
  const store = new SqliteHistoryStore(join(profile, 'history.db'))
  const pages: Array<[string, string, number]> = [['/files-alpha', 'Files alpha notes', 3], ['/files-beta', 'Files beta journal', 1], ['/docs', 'Documentation home', 2], ['/recipes', 'Recipes to try', 1]]
  for (const [path, title, visits] of pages) for (let n = 0; n < visits; n += 1) store.record(`${server.origin}${path}`, title, Date.now() - (n * 2 + 1) * DAY / 3)
  store.close()
}

/** Puts every view of the app in `scheme`, then pictures the whole virtual screen under `name`. */
async function snap (app: App, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  for (const scheme of ['light', 'dark'] as const) {
    for (const win of app.windows()) await Promise.race([win.emulateMedia({ colorScheme: scheme }).catch(() => undefined), delay(3000)])
    await delay(500)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)], { timeout: 20_000 })
  }
  for (const win of app.windows()) await Promise.race([win.emulateMedia({ colorScheme: null }).catch(() => undefined), delay(3000)])
}

async function park (chrome: Page): Promise<void> {
  await chrome.mouse.move(700, 14)
  await delay(200)
}

it('pictures the chrome and each library surface together', async () => {
  if (SHOTS_DIR === undefined) return
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, '--alsa-output-device=null'],
    env: { PULSE_SERVER: 'unix:/nonexistent' },
    seedProfile: seed
  })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await stubSystem(app, dir)
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(1280, 800) })
    const files = await visitFiles(app, chrome, server.origin)
    await park(chrome)
    await snap(app, '01-chrome-bar')

    await chrome.click('#address')
    await chrome.keyboard.press('ControlOrMeta+A')
    await chrome.keyboard.type('files', { delay: 40 })
    expect(await waitFor(async () => await popoverShown(app, 'overlay=omnibox'))).toBe(true)
    await delay(600)
    await snap(app, '02-omnibox')
    await chrome.keyboard.press('ArrowDown')
    await chrome.keyboard.press('ArrowDown')
    await delay(300)
    await snap(app, '03-omnibox-selected')
    await chrome.keyboard.press('Escape')
    await chrome.keyboard.press('Escape')
    await park(chrome)

    await chrome.click('#bookmarks-list .bmitem[data-id="work0000000"]')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=bookmark-folder'))).toBe(true)
    await delay(400)
    await snap(app, '04-bar-folder')
    await chrome.keyboard.press('Escape')
    await delay(300)

    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    await delay(500)
    await snap(app, '05-main-menu')
    await chrome.keyboard.press('Escape')
    await delay(300)

    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('page.qr') })
    expect(await waitFor(async () => await popoverShown(app, 'overlay=qr'))).toBe(true)
    await delay(700)
    await snap(app, '06-qr')
    await chrome.keyboard.press('Escape')
    await delay(300)

    await clickLink(files, '#file')
    await clickLink(files, '#exe')
    await clickLink(files, '#slow')
    const downloads = await openInternalPage(app, chrome, 'downloads')
    await waitFor(async () => await downloads.locator('.download').count() >= 3)
    await park(chrome)
    await snap(app, '07-downloads')

    await openInternalPage(app, chrome, 'history')
    await park(chrome)
    await snap(app, '08-history')

    await openInternalPage(app, chrome, 'about')
    await park(chrome)
    await snap(app, '09-about')

    await openInternalPage(app, chrome, 'tasks')
    await park(chrome)
    await snap(app, '10-tasks')

    await openInternalPage(app, chrome, 'settings', '/search')
    await park(chrome)
    await snap(app, '11-settings-search')

    await openInternalPage(app, chrome, 'settings', '/downloads')
    await park(chrome)
    await snap(app, '12-settings-downloads')

    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(700, 800) })
    await delay(700)
    await openInternalPage(app, chrome, 'tasks')
    await park(chrome)
    await snap(app, '13-narrow-tasks')
    await chrome.click('#bookmarks-list .bmitem[data-id="b1"]').catch(() => undefined)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
