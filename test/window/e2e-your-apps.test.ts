// The new tab's "Your apps" row: empty with the line that says what it is for, then the apps granted capabilities,
// most recently in front first, each opening like a typed address.
//
// RUN THIS WITH: node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/window/e2e-your-apps.test.ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { bundleTree } from '../../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../src/broker/policy/pin.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'
import { nodeLoaderStorage } from '../../src/loader/cache/node-storage.js'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import { navigateToFixture, pressCommand } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 240_000
const APPS = [
  { origin: 'https://your-apps-alpha.orivon.test', name: 'Alpha fixture' },
  { origin: 'https://your-apps-beta.orivon.test', name: 'Beta fixture' }
] as const

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const manifestOf = (app: (typeof APPS)[number]): Manifest => ({
  orivonApiVersion: 0,
  id: `app.orivon.${app.name.split(' ')[0]?.toLowerCase() ?? 'fixture'}-your-apps-e2e`,
  name: app.name,
  version: '1.0.0',
  entry: 'index.html',
  capabilities: { net: { https: { connect: ['*:*'] } } }
})

async function grantFixture (app: ElectronApplication, fixture: (typeof APPS)[number]): Promise<void> {
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const manifest = manifestOf(fixture)
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: '/index.html', content: new TextEncoder().encode(`<!doctype html><html><head><title>${fixture.name}</title></head><body>${fixture.name}</body></html>`) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(fixture.origin, entry.path, entry.content)
  await storage.writePin(fixture.origin, fromBundleTree(fixture.origin, tree.root, tree.assets, '1.0.0', 0))
  const done = await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const globals = globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant>, __orivonDevRegisterServing?: (origin: string) => Promise<void> }
    if (typeof globals.__orivonDevGrant !== 'function' || typeof globals.__orivonDevRegisterServing !== 'function') return false
    await globals.__orivonDevGrant(request)
    await globals.__orivonDevRegisterServing(request.origin)
    return true
  }, { origin: fixture.origin, manifest, capability: 'https.connect', patterns: ['*:*'] } satisfies DevGrantRequest)
  if (!done) throw new Error('the dev-only grant hooks are missing -- was this built via scripts/build-e2e.mjs?')
}

const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/newtab/'))
const yourApps = async (dashboard: Page): Promise<string[]> => await dashboard.locator('#your-apps-grid .tile-label').allInnerTexts()

it('lists the granted apps on the new tab, the one most recently in front first, and opens one like a typed address', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
    const first = dashboardOf(app) as Page
    expect(await waitFor(async () => await first.locator('#your-apps-section').isVisible())).toBe(true)
    expect(await first.locator('#your-apps-section .tile-section-title').innerText()).toMatch(/Your apps/i)
    expect(await first.locator('#your-apps-empty').innerText()).toBe('Apps you allow appear here')
    expect(await first.locator('#your-apps-grid .tile').count()).toBe(0)

    for (const fixture of APPS) await grantFixture(app, fixture)
    await navigateToFixture(app, `${APPS[0].origin}/`, APPS[0].name)
    await navigateToFixture(app, `${APPS[1].origin}/`, APPS[1].name)
    await pressCommand(app, 'your-apps-beta.orivon.test', 'tab.new')
    expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
    const second = dashboardOf(app) as Page
    expect(await waitFor(async () => (await yourApps(second)).length === 2)).toBe(true)
    expect(await yourApps(second)).toEqual([APPS[1].name, APPS[0].name])
    expect(await second.locator('#your-apps-empty').isHidden()).toBe(true)
    expect(await second.locator('#your-apps-grid .tile').evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('title')))).toEqual(APPS.map((fixture) => fixture.origin).reverse())
    expect(await second.locator('#your-apps-grid .tile-icon').count()).toBe(2)
    const shots = process.env['ORIVON_UI_SHOTS_DIR']
    if (shots !== undefined) {
      mkdirSync(shots, { recursive: true })
      await second.screenshot({ path: join(shots, 'your-apps-dashboard.png') })
    }

    // Opening the older app makes it the newest: a tile opens its tab like a typed address.
    await second.locator('#your-apps-grid .tile', { hasText: APPS[0].name }).click()
    const opened = await waitForTab(findChrome(app), { address: `${APPS[0].origin}/`, title: APPS[0].name })
    expect(opened.ok, JSON.stringify(opened.info)).toBe(true)
    await pressCommand(app, 'your-apps-alpha.orivon.test', 'tab.new')
    expect(await waitFor(async () => { const d = dashboardOf(app); return d !== undefined && (await yourApps(d)).join() === [APPS[0].name, APPS[1].name].join() })).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
