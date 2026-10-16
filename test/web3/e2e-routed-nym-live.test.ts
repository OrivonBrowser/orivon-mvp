// The real Nym module, live and opt-in (ORIVON_NYM_LIVE=1; CI never sets it): a routed app's HTTPS request, made with
// connectSecure, reaches a service that tells it the address it saw, and that address is not the one this computer
// has. The module's files are the ones the build pins, or the directory ORIVON_NYM_TUNNEL_DIR names (a build not yet
// published). Needs the e2e build first (scripts/build-e2e.mjs) and the network; the first request takes some seconds
// for the tunnel to come up.
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, waitForPageGlobal } from '../support/e2e-helpers.js'
import { launchShell } from '../support/qa-helpers.js'
import { findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'

const LIVE = process.env['ORIVON_NYM_LIVE'] === '1'
const ORIGIN = 'https://routed-nym-live.orivon.test'
const ROUTE_CHOICE = '.app-card:has-text("routed-nym-live") .app-route select'
const READY_BY_MS = 150_000

describe.skipIf(!LIVE)('the real Nym module', () => {
  let app: ElectronApplication
  let chrome: Page
  let view: Page

  beforeAll(async () => {
    const launched = await launchShell({ env: process.env['ORIVON_NYM_TUNNEL_DIR'] === undefined ? {} : { ORIVON_NYM_TUNNEL_DIR: process.env['ORIVON_NYM_TUNNEL_DIR'] } })
    app = launched.app
    chrome = launched.chrome
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: 'app.orivon.behaviour.routed-nym-live',
      name: 'Behaviour routed-nym-live',
      version: '1.0.0',
      entry: 'index.html',
      capabilities: { net: { https: { connect: ['api.ipify.org:443'] } } }
    }
    const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./routed-nym-live-entry.ts', import.meta.url))))
    const served = await serveApp(app, ORIGIN, manifest, 'https.connect', {
      '/index.html': new TextEncoder().encode('<!doctype html><title>routed nym live</title><body><script src="/app.js"></script></body>'),
      '/app.js': new TextEncoder().encode(script)
    }, manifest.capabilities.net?.https?.connect ?? [])
    expect(served).toEqual({ granted: true, registered: true })
    await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
    expect((await waitForTab(chrome, { address: `${ORIGIN}/` })).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, `${ORIGIN}/`) !== undefined)).toBe(true)
    view = findViewShowing(app, chrome, `${ORIGIN}/`) as Page
    await view.waitForLoadState('load')
    await waitForPageGlobal(view, 'routedNymLive')
  }, 180_000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  it('shows a routed app\'s HTTPS request the address of a mixnet exit, not this computer\'s', async () => {
    const direct = (await (await fetch('https://api.ipify.org')).text()).trim()
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/apps') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector(ROUTE_CHOICE)
    await settings.locator(ROUTE_CHOICE).selectOption('nym')
    await view.waitForLoadState('load')
    await waitForPageGlobal(view, 'routedNymLive')

    const started = Date.now()
    const reply = await view.evaluate(async () => await (globalThis as unknown as { routedNymLive: { exitAddress: () => Promise<{ ok: boolean, detail: string }> } }).routedNymLive.exitAddress())
    console.log(`[live] exit address ${reply.detail} (direct ${direct}) after ${String(Date.now() - started)} ms`)
    expect(reply.ok, reply.detail).toBe(true)
    expect(reply.detail).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
    expect(reply.detail).not.toBe(direct)
  }, READY_BY_MS)
})
