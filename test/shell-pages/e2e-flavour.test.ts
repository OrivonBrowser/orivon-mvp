// A package tagged for an app (src/main/flavour/), driven by its `--orivon-flavour=<id>` switch: the first run of a new
// default profile opens the app after the welcome screen and pins it first in Featured, once; a missing, malformed or
// unknown tag, and a profile that has run before, give the plain first run.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, activeTabInfo, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const TEST_TIMEOUT_MS = 90_000

function launch (flags: string[], intro: 'off' | 'once', reuseProfile?: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  return launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...flags],
    env: { ORIVON_INTRO: intro, ORIVON_DEFAULT_PROFILE: 'on', ...env },
    // The welcome screen covers the chrome view, which draws nothing while it does.
    chrome: intro === 'off',
    ...(reuseProfile === undefined ? {} : { reuseProfile })
  })
}

const introPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/intro/index.html'))
const dashboardPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))
const flavourFile = (dir: string): string => join(dir, 'flavour.json')

async function chromeOf (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return findChrome(app)
}

/** The Featured row as the dashboard shows it, once it has been drawn. */
async function featuredOf (app: ElectronApplication): Promise<Array<{ name: string, url: string | null }>> {
  expect(await waitFor(() => dashboardPage(app) !== undefined)).toBe(true)
  const dashboard = dashboardPage(app) as Page
  expect(await waitFor(async () => (await dashboard.locator('#featured-grid .tile').count()) >= 5)).toBe(true)
  return await dashboard.locator('#featured-grid .tile').evaluateAll((tiles) => tiles.map((tile) => ({ name: tile.querySelector('.tile-label')?.textContent ?? '', url: tile.getAttribute('title') })))
}

const PLAIN = ['Explore', 'WebTorrent', 'ASGARDEX', 'Ledger Wallet', 'The Lounge']

it('opens the tagged app after the welcome screen, pins it first, and stores the id once', async () => {
  const app = await launch(['--orivon-flavour=freetube'], 'once')
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const dir = profileDirOf(app) as string
    expect(await waitFor(() => existsSync(flavourFile(dir)))).toBe(true)
    expect(JSON.parse(await readFile(flavourFile(dir), 'utf8'))).toMatchObject({ id: 'freetube' })

    // Nothing opened behind the welcome screen: the app waits for the click that leaves it.
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeDefined()
    expect(dashboardPage(app)).toBeDefined()
    await (introPage(app) as Page).locator('#enter').click()
    expect(await waitFor(() => introPage(app) === undefined)).toBe(true)

    const chrome = await chromeOf(app)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address?.includes('freetube.orivonstack.eth') === true)).toBe(true)
    expect((await tabIds(chrome)).length).toBe(2)

    const row = await featuredOf(app)
    expect(row.map((tile) => tile.name)).toEqual(['FreeTube', ...PLAIN])
    expect(row[0]?.url).toBe('ipfs://freetube.orivonstack.eth')
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('opens the tagged app at once when the launch has no welcome screen, and pins an app of the shipped set where it is', async () => {
  const app = await launch(['--orivon-flavour=webtorrent'], 'off')
  try {
    const chrome = await chromeOf(app)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address?.includes('webtorrent.orivonstack.eth') === true)).toBe(true)
    expect((await featuredOf(app)).map((tile) => tile.name)).toEqual(['WebTorrent', 'Explore', 'ASGARDEX', 'Ledger Wallet', 'The Lounge'])
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('reads the tag from the name of the AppImage the browser was started from, and the switch wins over it', async () => {
  const app = await launch([], 'off', undefined, { APPIMAGE: '/home/someone/Downloads/Orivon-0.0.9-x86_64.element.AppImage' })
  try {
    const chrome = await chromeOf(app)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address?.includes('element.orivonstack.eth') === true)).toBe(true)
    expect((await featuredOf(app)).map((tile) => tile.name)[0]).toBe('Element')
  } finally {
    await closeElectronApp(app)
  }
  const other = await launch(['--orivon-flavour=explore'], 'off', undefined, { APPIMAGE: '/home/someone/Downloads/Orivon-0.0.9-x86_64.element.AppImage' })
  try {
    const chrome = await chromeOf(other)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address?.includes('explore.orivonstack.eth') === true)).toBe(true)
    expect((await featuredOf(other)).map((tile) => tile.name)).toEqual(PLAIN)
  } finally {
    await closeElectronApp(other)
  }
}, TEST_TIMEOUT_MS)

for (const [kind, flags] of [['no tag', []], ['a malformed tag', ['--orivon-flavour=Free_Tube']], ['an empty tag', ['--orivon-flavour=']], ['an unknown tag', ['--orivon-flavour=nosuchapp']], ['an address as the tag', ['--orivon-flavour=https://evil.example']], ['an app that is not on the list', ['--orivon-flavour=ledgerwallet']], ['two tags', ['--orivon-flavour=freetube', '--orivon-flavour=element']]] as const) {
  it(`${kind} gives the plain first run`, async () => {
    const app = await launch([...flags], 'off')
    try {
      const dir = profileDirOf(app) as string
      const chrome = await chromeOf(app)
      expect(await featuredOf(app).then((row) => row.map((tile) => tile.name))).toEqual(PLAIN)
      await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
      expect((await tabIds(chrome)).length).toBe(1)
      expect((await activeTabInfo(chrome)).address ?? '').not.toContain('orivonstack.eth')
      expect(existsSync(flavourFile(dir))).toBe(false)
    } finally {
      await closeElectronApp(app)
    }
  }, TEST_TIMEOUT_MS)
}

it('changes nothing on a profile that has run before', async () => {
  const first = await launch([], 'off')
  const dir = profileDirOf(first) as string
  await closeElectron(first, { keepProfile: true })
  expect(existsSync(join(dir, 'history.db'))).toBe(true)

  const second = await launch(['--orivon-flavour=freetube'], 'off', dir)
  try {
    const chrome = await chromeOf(second)
    expect(await featuredOf(second).then((row) => row.map((tile) => tile.name))).toEqual(PLAIN)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect((await tabIds(chrome)).length).toBe(1)
    expect(existsSync(flavourFile(dir))).toBe(false)
  } finally {
    await closeElectron(second)
  }
}, TEST_TIMEOUT_MS)
