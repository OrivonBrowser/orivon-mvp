// A change made elsewhere while a live page sits open: granting and revoking
// a permission (Settings > Apps), and a tab's visit (History). Neither page
// is reloaded or reopened by the test -- the push mechanism itself
// (start-internal-pages.ts's publish calls) is what has to move the DOM.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

// Chromium plays audio on the owner's real speakers even under xvfb; neither
// fixture page here has any, but every launch in this file mutes the
// backend anyway, matching every other Electron launch on this machine.
const MUTED_ENV = { PULSE_SERVER: 'unix:/nonexistent' }
const MUTE_ARGS = [HERMETIC_RESOLVER, '--alsa-output-device=null']

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Live update fixture</title><p>hello</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: MUTE_ARGS, env: MUTED_ENV })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function openInternal (app: ElectronApplication, chrome: Page, page: string, path?: string): Promise<Page> {
  await chrome.evaluate(({ page: p, path: at }) => {
    (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal(p, at)
  }, { page, path })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(`orivon://${page}`)))).toBe(true)
  return app.windows().find((w) => w.url().startsWith(`orivon://${page}`)) as Page
}

/** Grants or revokes from outside the Settings page entirely -- the dev-only
 * test seam every e2e test that needs a real grant already uses (see
 * dev-grant.ts's own header): never through window.orivon, never through the
 * Settings page's own `apps` request channel. */
async function devGrant (app: ElectronApplication, request: DevGrantRequest): Promise<Grant> {
  return await app.evaluate(async (_electron, req: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') throw new Error('the dev-grant hook is not installed in this build')
    return await hook(req)
  }, request)
}

async function devRevoke (app: ElectronApplication, origin_: string, grantId: Grant['id']): Promise<void> {
  await app.evaluate(async (_electron, { origin: o, grantId: id }: { origin: string, grantId: Grant['id'] }) => {
    const hook = (globalThis as unknown as { __orivonDevRevoke?: (o: string, id: Grant['id']) => Promise<void> }).__orivonDevRevoke
    if (typeof hook !== 'function') throw new Error('the dev-revoke hook is not installed in this build')
    await hook(o, id)
  }, { origin: origin_, grantId })
}

function fixtureManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.settings-live-e2e',
    name: 'Settings live-update e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: [],
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
}

it('shows a permission granted elsewhere, and its revoke, on an already-open Apps section', async () => {
  const { app, chrome } = await launched()
  try {
    const fixtureOrigin = 'http://127.0.0.1:47501'
    const page = await openInternal(app, chrome, 'settings', '/apps')
    await page.waitForSelector('.apps, .muted')
    expect(await page.locator('.app-card').count()).toBe(0)

    const granted = await devGrant(app, { origin: fixtureOrigin, manifest: fixtureManifest(), capability: 'tcp.connect', patterns: ['127.0.0.1:9'] })

    // No reload, no re-open: the same Page object, the same DOM, must gain
    // the card on its own once main publishes apps.changed.
    expect(await waitFor(async () => (await page.locator('.app-card').count()) === 1)).toBe(true)
    const card = page.locator('.app-card', { hasText: '127.0.0.1:47501' })
    expect(await card.locator('.muted').first().textContent()).toContain('Settings live-update e2e fixture')

    await devRevoke(app, fixtureOrigin, granted.id)

    // The card itself stays (it is a loaded app for the rest of the session,
    // permissions.ts's own PermissionsRegistry.list() doc): what has to
    // disappear live is the one permission row the revoke took away.
    expect(await waitFor(async () => (await card.locator('.perm').count()) === 0)).toBe(true)
    expect(await card.textContent()).toContain('Nothing is granted to it now.')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows a page visited in another tab on an already-open History page', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openInternal(app, chrome, 'history')
    await page.waitForSelector('.page')
    expect(await page.locator('.entry').count()).toBe(0)

    // A NEW tab: opening History made it the active one, and typing into
    // chrome's own address bar navigates whichever tab is active -- without
    // this, the visit would replace the History page itself instead of
    // being a separate tab it hears about.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    await clickAddressBarRetrying(chrome, `${origin}/`)
    expect((await waitForTab(chrome, { address: `${origin}/` })).ok).toBe(true)

    // Same Page object throughout: the entry has to arrive by itself, via
    // history.changed, well inside the coalescing window (about a second).
    expect(await waitFor(async () => (await page.locator('.entry').count()) === 1)).toBe(true)
    expect(await page.locator('.entry .title').first().textContent()).toBe('Live update fixture')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
