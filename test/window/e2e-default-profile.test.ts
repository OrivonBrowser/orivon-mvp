// What a new profile starts with: five bookmarks with icons, uBlock Origin installed and pinned, the
// Extensions button shown, and "Orivon Featured" on the new tab; and that none of it comes back once the person
// removed it. Every other spec runs with ORIVON_DEFAULT_PROFILE=off (test/support/launch-electron.mjs).
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { readRegistry } from '../../src/main/extensions/registry-runner.js'
import { serializeRegistry } from '../../src/main/extensions/registry.js'

const TEST_TIMEOUT_MS = 240_000
const UBLOCK_ORIGIN_CRX = join(import.meta.dirname, '../../resources/default-profile/extensions/ublock-origin.crx')
const UBLOCK_ORIGIN_ID = 'fkgkibajhfbepljeaefdnfnegdcjomkh'
const BAR = ['Uniswap', 'James Carnley', 'ENS Interviews', 'Web3 Compass', 'Vitalik Buterin']
const FEATURED = [
  ['Explore', 'ipfs://explore.orivonstack.eth'],
  ['The Lounge', 'ipfs://thelounge.orivonstack.eth'],
  ['FreeTube', 'ipfs://freetube.orivonstack.eth'],
  ['ASGARDEX', 'ipfs://asgardex.orivonstack.eth'],
  ['Element', 'ipfs://element.orivonstack.eth']
]

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

async function launched (reuseProfile?: string): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_DEFAULT_PROFILE: 'on' },
    sandbox: true,
    ...(reuseProfile === undefined ? {} : { reuseProfile })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const barItems = async (chrome: Page): Promise<Array<{ title: string, image: string | null }>> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('#bookmarks-list .bmitem')).filter((el) => !el.hidden).map((el) => ({
    title: el.getAttribute('aria-label') ?? '',
    image: el.querySelector('img')?.getAttribute('src')?.slice(0, 22) ?? null
  })))

const toolbarIds = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelector('browser-action-list')?.shadowRoot?.querySelectorAll('.action') ?? []).map((el) => el.id))

const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/newtab/'))

it('starts a new profile with the bookmarks, uBlock Origin pinned, the Extensions button and Orivon Featured', async () => {
  expect(existsSync(UBLOCK_ORIGIN_CRX), 'run node scripts/fetch-bundled-extensions.mjs').toBe(true)
  const { app, chrome } = await launched()
  const dir = profileDirOf(app) as string
  try {
    expect(await waitFor(async () => (await barItems(chrome)).length === BAR.length)).toBe(true)
    const items = await barItems(chrome)
    expect(items.map((item) => item.title)).toEqual(BAR)
    for (const item of items) expect(item.image, item.title).toBe('data:image/png;base64,')

    expect(await waitFor(() => readRegistry(dir).some((entry) => entry.id === UBLOCK_ORIGIN_ID && entry.enabled))).toBe(true)
    const prefsFile = join(dir, 'extensions', 'prefs.json')
    const pinnedOnDisk = async (): Promise<unknown> => { try { return (JSON.parse(await readFile(prefsFile, 'utf8')) as { extensions: Record<string, { pinned: boolean }> }).extensions[UBLOCK_ORIGIN_ID]?.pinned } catch { return undefined } }
    expect(await waitFor(async () => await pinnedOnDisk() === true)).toBe(true)
    expect(await waitFor(async () => (await toolbarIds(chrome)).includes(UBLOCK_ORIGIN_ID))).toBe(true)

    expect(await evaluateRetrying(chrome, () => {
      const button = document.getElementById('extensions-menu-btn')
      return button !== null && !button.hidden && button.getBoundingClientRect().width > 0
    })).toBe(true)

    expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
    const dashboard = dashboardOf(app) as Page
    expect(await dashboard.locator('#featured-section .tile-section-title').innerText()).toMatch(/Orivon Featured/i)
    const tiles = dashboard.locator('#featured-grid .tile')
    expect(await tiles.count()).toBe(FEATURED.length)
    expect(await dashboard.locator('#featured-grid .tile-label').allInnerTexts()).toEqual(FEATURED.map(([title]) => title))
    expect(await tiles.evaluateAll((all) => all.map((tile) => tile.getAttribute('title')))).toEqual(FEATURED.map(([, url]) => url))
    expect(await waitFor(async () => (await tiles.evaluateAll((all) => all.map((tile) => {
      const image = tile.querySelector('img')
      return image !== null && image.complete && image.naturalWidth > 0
    }))).every(Boolean))).toBe(true)
    expect(await dashboard.locator('#bookmarks-section .tile-section-title').innerText()).toMatch(/Bookmarks/i)
    expect(await waitFor(async () => (await dashboard.locator('#bookmarks-grid .tile-label').allInnerTexts()).join() === BAR.join())).toBe(true)
  } finally {
    await closeElectron(app, { keepProfile: true })
  }

  // A person removed a bookmark and every extension: the next start puts none of them back.
  const bookmarksFile = join(dir, 'bookmarks.json')
  const stored = JSON.parse(await readFile(bookmarksFile, 'utf8')) as { roots: { bar: unknown[] } }
  stored.roots.bar.shift()
  await writeFile(bookmarksFile, JSON.stringify(stored))
  await writeFile(join(dir, 'extensions', 'registry.json'), serializeRegistry([]))
  const second = await launched(dir)
  try {
    expect(await waitFor(async () => (await barItems(second.chrome)).length === BAR.length - 1)).toBe(true)
    expect((await barItems(second.chrome)).map((item) => item.title)).toEqual(BAR.slice(1))
    expect(readRegistry(dir)).toEqual([])
  } finally {
    await closeElectron(second.app)
  }
}, TEST_TIMEOUT_MS)
