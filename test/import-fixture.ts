// What the import end-to-end files share: fake homes holding the profile files of other browsers (built here,
// never read from the machine running the test), the launch that points the detector at one, and the stand-ins
// for the file dialog.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { makeChromeHistory, makeFirefoxPlaces } from '../src/main/import/tests/databases.js'
import { launchElectron } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'

export interface Launched {
  readonly app: ElectronApplication
  readonly chrome: Page
}

const MINUTE = 60_000

const chromeBookmarks = (): string => JSON.stringify({ roots: {
  bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
    { type: 'url', name: 'Chrome bar item', url: 'https://chrome-bar.test/', date_added: '13300000000000000' },
    { type: 'folder', name: 'Reading', children: [{ type: 'url', name: 'Deep read', url: 'https://deep.test/' }] },
    { type: 'url', name: 'Sneaky script', url: 'javascript:alert(1)' }
  ] },
  other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'Other site', url: 'https://other.test/' }] }
} })

/** A home directory with Chrome (two profiles) and, when asked, Firefox. The pages are dated minutes ago, so they are inside any retention. */
export async function fakeHome (options: { firefox?: boolean, chrome?: boolean } = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orivon-import-home-'))
  if (options.chrome !== false) {
    const root = join(home, '.config', 'google-chrome')
    await mkdir(join(root, 'Default'), { recursive: true })
    await mkdir(join(root, 'Profile 1'), { recursive: true })
    await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' } } } }))
    await writeFile(join(root, 'Default', 'Bookmarks'), chromeBookmarks())
    const now = Date.now()
    makeChromeHistory(join(root, 'Default', 'History'), [
      { url: 'https://imported-one.test/', title: 'Imported history page', visits: 4, at: now - 5 * MINUTE },
      { url: 'https://imported-two.test/', title: 'Second imported page', visits: 1, at: now - 10 * MINUTE },
      { url: 'https://imported-three.test/', title: 'Third imported page', visits: 2, at: now - 20 * MINUTE }
    ], { wal: false }).close()
    await writeFile(join(root, 'Profile 1', 'Bookmarks'), chromeBookmarks())
  }
  if (options.firefox === true) {
    const root = join(home, '.mozilla', 'firefox')
    await mkdir(join(root, 'abc.default-release'), { recursive: true })
    await writeFile(join(root, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\n')
    makeFirefoxPlaces(join(root, 'abc.default-release', 'places.sqlite'), [{ url: 'https://fox-history.test/', title: 'Fox history', visits: 1, at: Date.now() - MINUTE }], [
      { id: 1, type: 2, parent: 0, position: 0, title: '', guid: 'root________' },
      { id: 3, type: 2, parent: 1, position: 0, title: 'Toolbar', guid: 'toolbar_____' },
      { id: 4, type: 1, parent: 3, position: 0, title: 'Fox bookmark', guid: 'g4', url: 'https://fox.test/' }
    ]).close()
  }
  return home
}

export async function removeHome (home: string): Promise<void> {
  await rm(home, { recursive: true, force: true })
}

export async function launchImport (home: string, options: { args?: string[], settings?: Record<string, unknown> } = {}): Promise<Launched> {
  const { args = [], settings } = options
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...args],
    env: { ORIVON_TEST_IMPORT_HOME: home },
    ...(settings === undefined ? {} : { seedProfile: async (dir: string) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: settings })) } })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** The file dialog answers with `file` (or never answers, for a state that waits), so no real dialog opens. */
export async function stubFileDialog (app: ElectronApplication, file: string | 'never'): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => path === 'never' ? await new Promise(() => {}) : { canceled: false, filePaths: [path] }) as unknown as typeof dialog.showOpenDialog
  }, file)
}

export async function runCommand (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

/** The Import page once it has found what there is to choose from. */
export async function openImportPage (app: ElectronApplication, chrome: Page): Promise<Page> {
  await runCommand(chrome, 'import.open')
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://import')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://import')) as Page
  await page.waitForSelector('.page')
  return page
}

/** The titles on the bookmarks bar, as the chrome shows them. */
export async function barTitles (chrome: Page): Promise<string[]> {
  return await chrome.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#bookmarks-list .bmitem')).filter((el) => !el.hidden).map((el) => el.getAttribute('aria-label') ?? ''))
}
