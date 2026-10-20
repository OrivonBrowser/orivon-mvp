// What a new profile starts with: five bookmarks with icons, uBlock Origin installed and pinned, the
// Extensions button shown, and "Orivon Featured" on the new tab; and that none of it comes back once the person
// removed it; and that a Featured tile can be hidden and brought back, and that the app a profile was given first shows first until
// the person removes it. Set ORIVON_UI_SHOTS_DIR to also write a screenshot of the window. Every other spec runs with ORIVON_DEFAULT_PROFILE=off (test/support/launch-electron.mjs).
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright'
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
  ['WebTorrent', 'ipfs://webtorrent.orivonstack.eth'],
  ['ASGARDEX', 'ipfs://asgardex.orivonstack.eth'],
  ['Ledger Wallet', 'ipfs://ledgerwallet.orivonstack.eth'],
  ['The Lounge', 'ipfs://thelounge.orivonstack.eth']
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
    const shots = process.env['ORIVON_UI_SHOTS_DIR']
    if (shots !== undefined) {
      mkdirSync(shots, { recursive: true })
      await chrome.screenshot({ path: join(shots, 'default-profile-chrome.png') })
      await dashboard.screenshot({ path: join(shots, 'default-profile-dashboard.png') })
    }
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
    await closeElectron(second.app, { keepProfile: true })
  }

  // A profile the browser already ran on, with no bookmarks and no extensions, is not new: history.db is what it left.
  await rm(bookmarksFile)
  await rm(join(dir, 'extensions', 'registry.json'))
  expect(existsSync(join(dir, 'history.db'))).toBe(true)
  const third = await launched(dir)
  try {
    expect(await waitFor(() => dashboardOf(third.app) !== undefined)).toBe(true)
    expect(await barItems(third.chrome)).toEqual([])
    expect(existsSync(join(dir, 'bookmarks.json'))).toBe(false)
    expect(existsSync(join(dir, 'extensions', 'registry.json'))).toBe(false)
  } finally {
    await closeElectron(third.app)
  }
}, TEST_TIMEOUT_MS)

const featuredNames = async (dashboard: Page): Promise<string[]> => await dashboard.locator('#featured-grid .tile-label').allInnerTexts()
/** A tile's control, by its accessible name: a control is hidden until its tile is hovered or holds the keyboard, so a role query cannot see it. */
const control = (dashboard: Page, name: string): Locator => dashboard.locator(`#featured-grid button[aria-label="${name}"]`)
/** Hovers the tile the control belongs to, which shows it, and presses it. */
async function pressControl (dashboard: Page, name: string): Promise<void> {
  await control(dashboard, name).locator('xpath=ancestor::*[contains(@class, "tile-wrap")]').hover()
  await control(dashboard, name).click()
}

it('hides a Featured tile and brings it back, and shows the app a profile was given first until it is removed', async () => {
  const first = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true })
  const dir = profileDirOf(first) as string
  try {
    expect(await waitFor(() => dashboardOf(first) !== undefined)).toBe(true)
    const dashboard = dashboardOf(first) as Page
    expect(await waitFor(async () => (await featuredNames(dashboard)).length === FEATURED.length)).toBe(true)
    expect(await dashboard.locator('#featured-show-hidden').isHidden()).toBe(true)

    // The controls are on the keyboard's path: a tile that is not hovered or focused shows none, and once the tile has the
    // keyboard the next Tab reaches them.
    const hideWebTorrent = control(dashboard, 'Hide WebTorrent')
    const controlsShown = async (): Promise<string> => await hideWebTorrent.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).visibility)
    expect(await controlsShown()).toBe('hidden')
    await dashboard.locator('.tile[data-id="webtorrent"]').focus()
    expect(await controlsShown()).toBe('visible')
    await dashboard.keyboard.press('Tab')
    expect(await dashboard.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Hide WebTorrent')
    await dashboard.keyboard.press('Enter')
    expect(await waitFor(async () => (await featuredNames(dashboard)).join() === ['Explore', 'ASGARDEX', 'Ledger Wallet', 'The Lounge'].join())).toBe(true)
    expect(await dashboard.locator('#featured-show-hidden').innerText()).toBe('Show hidden (1)')
    // The keyboard stays in the row, on the tile that took the place.
    expect(await dashboard.evaluate(() => document.activeElement?.closest('.tile')?.querySelector('.tile-label')?.textContent ?? null)).toBe('ASGARDEX')
  } finally {
    await closeElectron(first, { keepProfile: true })
  }

  // Given at first run by a later change; here the file says so. The pin shows first, and the hidden tile stays hidden.
  const file = join(dir, 'new-tab.json')
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, hidden: ['webtorrent'], newcomerPin: null, given: false })
  await writeFile(file, JSON.stringify({ version: 1, newcomerPin: 'ledgerwallet', given: true, unpinned: [], hidden: ['webtorrent'] }))
  const second = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true, reuseProfile: dir })
  try {
    expect(await waitFor(() => dashboardOf(second) !== undefined)).toBe(true)
    const dashboard = dashboardOf(second) as Page
    expect(await waitFor(async () => (await featuredNames(dashboard)).length === 4)).toBe(true)
    expect(await featuredNames(dashboard)).toEqual(['Ledger Wallet', 'Explore', 'ASGARDEX', 'The Lounge'])

    await pressControl(dashboard, 'Unpin Ledger Wallet')
    expect(await waitFor(async () => (await featuredNames(dashboard)).join() === ['Explore', 'ASGARDEX', 'Ledger Wallet', 'The Lounge'].join())).toBe(true)
    await dashboard.locator('#featured-show-hidden').click()
    expect(await waitFor(async () => (await featuredNames(dashboard)).join() === FEATURED.map(([title]) => title).join())).toBe(true)
    expect(await dashboard.locator('#featured-show-hidden').isHidden()).toBe(true)
  } finally {
    await closeElectron(second, { keepProfile: true })
  }

  // Removed for good: the file keeps that a pin was given, and the next start shows the plain row.
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ newcomerPin: null, given: true, unpinned: ['ledgerwallet'], hidden: [] })
  const third = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true, reuseProfile: dir })
  try {
    expect(await waitFor(() => dashboardOf(third) !== undefined)).toBe(true)
    const dashboard = dashboardOf(third) as Page
    expect(await waitFor(async () => (await featuredNames(dashboard)).length === FEATURED.length)).toBe(true)
    expect(await featuredNames(dashboard)).toEqual(FEATURED.map(([title]) => title))
  } finally {
    await closeElectron(third, { keepProfile: true })
  }

  // An app outside the shipped set gets a tile with a letter for its icon, first in the row; hiding it removes it for good.
  await writeFile(file, JSON.stringify({ version: 1, newcomerPin: 'newapp', given: true, unpinned: [], hidden: [] }))
  const fourth = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true, reuseProfile: dir })
  try {
    expect(await waitFor(() => dashboardOf(fourth) !== undefined)).toBe(true)
    const dashboard = dashboardOf(fourth) as Page
    expect(await waitFor(async () => (await featuredNames(dashboard)).length === FEATURED.length + 1)).toBe(true)
    expect(await featuredNames(dashboard)).toEqual(['newapp', ...FEATURED.map(([title]) => title)])
    expect(await dashboard.locator('#featured-grid .tile').first().getAttribute('title')).toBe('ipfs://newapp.orivonstack.eth')
    expect(await dashboard.locator('#featured-grid .tile-letter').first().innerText()).toBe('N')
    const shots = process.env['ORIVON_UI_SHOTS_DIR']
    if (shots !== undefined) {
      mkdirSync(shots, { recursive: true })
      await control(dashboard, 'Hide ASGARDEX').evaluate((el) => { el.parentElement?.style.setProperty('visibility', 'visible') })
      await dashboard.screenshot({ path: join(shots, 'featured-pinned-outsider.png') })
    }
    await pressControl(dashboard, 'Hide newapp')
    expect(await waitFor(async () => (await featuredNames(dashboard)).join() === FEATURED.map(([title]) => title).join())).toBe(true)
    // Nothing to bring back: the pin is gone, not hidden.
    expect(await dashboard.locator('#featured-show-hidden').isHidden()).toBe(true)
  } finally {
    await closeElectron(fourth)
  }
}, TEST_TIMEOUT_MS)
