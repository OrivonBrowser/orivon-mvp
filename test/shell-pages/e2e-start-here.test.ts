// The "Start here" card on the new tab (src/main/newtab/start-here-state.ts): three steps ticked from what the browser
// sees, one dismissal that lasts across a restart, and the import step only where another browser's profile exists.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { fakeHome, removeHome } from '../library/import-fixture.js'
import { clickAddressBarRetrying, closeElectronApp, setScheme, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { activeTabInfo, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const TEST_TIMEOUT_MS = 120_000

async function launch (home: string, options: { reuseProfile?: string, flags?: string[], env?: Record<string, string> } = {}): Promise<ElectronApplication> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.flags ?? [])],
    env: { ORIVON_TEST_IMPORT_HOME: home, ...options.env },
    ...(options.reuseProfile === undefined ? {} : { reuseProfile: options.reuseProfile })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return app
}

const dashboards = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/newtab/index.html'))
const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

async function dashboard (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
  return dashboardOf(app) as Page
}

/** The steps the card shows, in order, with whether each is ticked. */
async function steps (page: Page): Promise<Array<{ id: string, done: boolean }>> {
  return await page.locator('#start-here-steps .start-step').evaluateAll((items) => items.map((item) => ({ id: item.getAttribute('data-step') ?? '', done: item.getAttribute('data-done') === '1' })))
}

const stored = async (dir: string): Promise<{ start: { done: string[], closed: boolean } }> => JSON.parse(await readFile(join(dir, 'new-tab.json'), 'utf8')) as { start: { done: string[], closed: boolean } }

/** A page of its own at an address the developer hook can grant: the origin of an app, as far as the browser can tell. */
async function appServer (): Promise<{ server: Server, url: string }> {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>start-here-app</title><body>app</body>') })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture server did not bind a port')
  return { server, url: `http://127.0.0.1:${String(address.port)}/` }
}

async function grantFs (app: ElectronApplication, origin: string): Promise<void> {
  const manifest = { orivonApiVersion: 0, id: 'app.orivon.fixture.start-here', name: 'Start Here Fixture', version: '1.0.0', entry: 'index.html', capabilities: { fs: { quotaBytes: 1024 } } }
  const granted = await app.evaluate(async (_electron, request) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: unknown) => Promise<unknown> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook({ origin: request.origin, manifest: request.manifest, capability: 'fs', patterns: [] })
    return true
  }, { origin, manifest })
  expect(granted, 'the developer grant hook is built into the e2e build').toBe(true)
}

it('shows the card on a fresh profile with FreeTube, reachable and operable by keyboard, and opens the app from it', async () => {
  const home = await fakeHome({ chrome: false })
  const app = await launch(home)
  try {
    const page = await dashboard(app)
    await page.locator('#start-here').waitFor({ state: 'visible' })
    expect(await page.getByRole('region', { name: 'Start here' }).isVisible()).toBe(true)
    expect(await steps(page)).toEqual([{ id: 'app', done: false }, { id: 'eth', done: false }])
    expect(await page.locator('#start-here-steps .step-title').allInnerTexts()).toEqual(['Open an app', 'See the shield on a .eth name'])
    expect(await page.locator('.step-detail').innerText()).toBe('The shield in the address bar shows how the name was checked.')
    expect(await page.locator('#start-here-ubo').isHidden()).toBe(true)
    // Each unticked step says so to a screen reader.
    expect(await page.locator('.start-step').first().innerText()).toContain('To do:')

    // Tab from the search box: Dismiss, then each step's button, by their accessible names.
    await page.locator('#search-input').focus()
    const reached: string[] = []
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab')
      reached.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''))
    }
    expect(reached).toEqual(['Dismiss Start here', 'Open FreeTube', 'Open a .eth site'])
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    const chrome = findChrome(app)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address?.includes('freetube.orivonstack.eth') === true)).toBe(true)
  } finally {
    await closeElectronApp(app)
    await removeHome(home)
  }
}, TEST_TIMEOUT_MS)

it('offers the app a package was tagged for in place of FreeTube', async () => {
  const home = await fakeHome({ chrome: false })
  const app = await launch(home, { flags: ['--orivon-flavour=explore'], env: { ORIVON_INTRO: 'off', ORIVON_DEFAULT_PROFILE: 'on' } })
  try {
    const page = await dashboard(app)
    await page.locator('#start-here').waitFor({ state: 'visible' })
    expect(await page.locator('.start-step[data-step="app"] .step-action').innerText()).toBe('Open Explore')
  } finally {
    await closeElectronApp(app)
    await removeHome(home)
  }
}, TEST_TIMEOUT_MS)

it('shows the import step only where another browser has a profile, and ticks it once an import has run', async () => {
  const home = await fakeHome()
  const app = await launch(home)
  try {
    const page = await dashboard(app)
    await page.locator('#start-here').waitFor({ state: 'visible' })
    expect((await steps(page)).map((step) => step.id)).toEqual(['app', 'eth', 'import'])
    await page.locator('.start-step[data-step="import"] .step-action').click()
    const chrome = findChrome(app)
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://import')))).toBe(true)
    const importPage = app.windows().find((w) => w.url().startsWith('orivon://import')) as Page
    await importPage.waitForSelector('.listbox-item')
    await importPage.locator('button[data-focus="import"]').click()
    await importPage.waitForSelector('.banner.ok')

    const dir = profileDirOf(app) as string
    expect(await waitFor(async () => (await stored(dir)).start.done.includes('import'))).toBe(true)
    await chrome.click('#new-tab')
    // The Import page opened beside the first dashboard, which still shows what it was given; the new one is told.
    const ticked = async (): Promise<Page | undefined> => {
      for (const candidate of dashboards(app)) if ((await steps(candidate)).some((step) => step.id === 'import' && step.done)) return candidate
      return undefined
    }
    expect(await waitFor(async () => await ticked() !== undefined)).toBe(true)
    const fresh = (await ticked()) as Page
    expect(await fresh.locator('.start-step[data-step="import"]').innerText()).toContain('Done:')
    const shots = process.env['ORIVON_UI_SHOTS_DIR']
    if (shots !== undefined) {
      mkdirSync(shots, { recursive: true })
      for (const scheme of ['light', 'dark'] as const) {
        await setScheme(app, scheme)
        await fresh.screenshot({ path: join(shots, `start-here-three-steps-${scheme}.png`) })
      }
    }
  } finally {
    await closeElectronApp(app)
    await removeHome(home)
  }
}, TEST_TIMEOUT_MS)

it('ticks the first step once an app has opened, and the tick stays', async () => {
  const home = await fakeHome({ chrome: false })
  const { server, url } = await appServer()
  const app = await launch(home)
  try {
    await grantFs(app, url)
    const chrome = findChrome(app)
    await waitForAddressBarStable(chrome)
    await clickAddressBarRetrying(chrome, url)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).title === 'start-here-app')).toBe(true)
    const dir = profileDirOf(app) as string
    expect(await waitFor(async () => (await stored(dir)).start.done.includes('app'))).toBe(true)

    await chrome.click('#new-tab')
    expect(await waitFor(async () => { const fresh = dashboardOf(app); return fresh !== undefined && (await steps(fresh)).some((step) => step.id === 'app' && step.done) })).toBe(true)
    const fresh = dashboardOf(app) as Page
    expect(await steps(fresh)).toEqual([{ id: 'app', done: true }, { id: 'eth', done: false }])
  } finally {
    await closeElectronApp(app)
    server.close()
    await removeHome(home)
  }
}, TEST_TIMEOUT_MS)

it('leaves for good after Dismiss, across a restart', async () => {
  const home = await fakeHome({ chrome: false })
  const first = await launch(home)
  const dir = profileDirOf(first) as string
  try {
    const page = await dashboard(first)
    await page.locator('#start-here').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Dismiss Start here' }).click()
    expect(await page.locator('#start-here').isHidden()).toBe(true)
    expect(await waitFor(async () => (await stored(dir)).start.closed)).toBe(true)
    // The keyboard goes back to the search box rather than to a control that is gone.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search-input')
  } finally {
    await closeElectron(first, { keepProfile: true })
  }
  const second = await launch(home, { reuseProfile: dir })
  try {
    const page = await dashboard(second)
    expect(await waitFor(async () => (await page.locator('#featured-grid .tile').count()) > 0)).toBe(true)
    expect(await page.locator('#start-here').isHidden()).toBe(true)
  } finally {
    await closeElectron(second)
    await removeHome(home)
  }
}, TEST_TIMEOUT_MS)
