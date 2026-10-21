// With the whole browser on the tunnel, an installed app with no setting of its own follows the default: its
// `orivon.net` calls go through the tunnel with the name unresolved here and its own sign-in, and a call to a name the
// tunnel knows reaches the real server and never the decoy on the same port. An app the person switches off from its
// card in Apps is asked about the system's proxy as before (T20), not about the tunnel's front on the default session:
// the call is not refused as "a proxy applies", it simply cannot resolve the name here, and nothing reaches the tunnel.
// Switched on again, it follows the default and works.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-everywhere-app.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Manifest } from '../../src/contracts/index.js'
import { shoot } from '../support/auth-support.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, waitForPageGlobal } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'
import type { Attempt } from './routed-network-entry.js'

const ORIGIN = 'https://tunnel-everywhere-app-e2e.orivon.test'
const ROUTE_CHOICE = '.app-card:has-text("tunnel-everywhere-app") .app-route select'
const NAME = 'tcp.socks.test'

interface Counting { readonly port: number, readonly connections: () => number, readonly close: () => Promise<void> }

async function counting (onConnection?: (socket: Socket) => void): Promise<Counting> {
  const open = new Set<Socket>()
  let connections = 0
  const server: Server = createServer((socket) => {
    connections += 1
    open.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => { open.delete(socket) })
    onConnection?.(socket)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

let dir: string
let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let view: Page
let decoy: Counting
let echo: Counting
let loopbackEcho: Counting
const cleanups: Array<() => Promise<void> | void> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-everywhere-app-e2e-'))
  decoy = await counting()
  echo = await counting((socket) => { socket.on('data', (chunk) => socket.write(chunk)) })
  loopbackEcho = await counting((socket) => { socket.on('data', (chunk) => socket.write(chunk)) })
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: echo.port } } })
  cleanups.push(async () => { await decoy.close() }, async () => { await echo.close() }, async () => { await loopbackEcho.close() }, async () => { await socks.close() }, () => { rmSync(dir, { recursive: true, force: true }) })

  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./routed-network-entry.ts', import.meta.url))))
  const launched = await launchShell({
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
    }
  })
  app = launched.app
  chrome = launched.chrome

  const connect = [`${NAME}:${String(decoy.port)}`, `127.0.0.1:${String(loopbackEcho.port)}`]
  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.behaviour.tunnel-everywhere-app',
    name: 'Behaviour tunnel-everywhere-app',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { net: { tcp: { connect } } }
  }
  const served = await serveApp(app, ORIGIN, manifest, 'tcp.connect', {
    '/index.html': new TextEncoder().encode('<!doctype html><title>tunnel everywhere app</title><body><script src="/app.js"></script></body>'),
    '/app.js': new TextEncoder().encode(script)
  }, connect, [])
  expect(served).toEqual({ granted: true, registered: true })
  view = await openApp()
}, 180_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openApp (): Promise<Page> {
  await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
  expect((await waitForTab(chrome, { address: `${ORIGIN}/` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, `${ORIGIN}/`) !== undefined)).toBe(true)
  const page = findViewShowing(app, chrome, `${ORIGIN}/`) as Page
  await page.waitForLoadState('load')
  await waitForPageGlobal(page, 'routedNetworkE2e')
  return page
}

async function tcp (host: string, port: number): Promise<Attempt> {
  return await view.evaluate(async ({ host: target, port: number }) => {
    const entry = (globalThis as unknown as { routedNetworkE2e: { tcp: (host: string, port: number) => Promise<unknown> } }).routedNetworkE2e
    return await entry.tcp(target, number)
  }, { host, port }) as Attempt
}

async function openApps (): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/apps') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await settings.waitForSelector(ROUTE_CHOICE)
  return settings
}

const dialed = (): boolean => socks.requests.some((request) => request.destination === NAME && request.port === decoy.port && request.addressType === 'domain')

it('[app:tunnel-everywhere-app-follows-the-default] an app with no setting dials by name through the tunnel, and the decoy on the same port is never reached', async () => {
  const attempt = await tcp(NAME, decoy.port)
  expect(attempt, 'connect by name').toMatchObject({ ok: true, detail: 'ping' })
  expect(dialed(), 'the name was asked of the tunnel, unresolved').toBe(true)
  expect(socks.requests.find((request) => request.destination === NAME)?.userId, 'with the app\'s own sign-in').toBeDefined()
  expect(decoy.connections()).toBe(0)

  const settings = await openApps()
  expect(await settings.locator(ROUTE_CHOICE).inputValue(), 'its card shows the default tunnel, the proxy').toBe('socks5')
  await shoot(app, chrome, settings, 'tunnel-everywhere-app-card')
  await settings.close()
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-app-set-to-off-asks-the-system] an app switched off is asked about the system\'s proxy, not the tunnel\'s front: it reaches this computer, resolves nothing at the far end, and the tunnel sees nothing', async () => {
  const seen = socks.requests.length
  const settings = await openApps()
  await settings.locator(ROUTE_CHOICE).selectOption('')
  await settings.close()
  // The app's pages are reloaded when its route is switched.
  expect(await waitFor(async () => (await tcp(NAME, decoy.port).catch((): Attempt => ({ ok: true, detail: '' }))).code !== undefined), 'the app\'s call no longer goes through the tunnel').toBe(true)

  const byName = await tcp(NAME, decoy.port)
  expect(byName.ok, 'this computer cannot resolve the name').toBe(false)
  // Not refused because "a system proxy is configured" (T20): the tunnel's front on the default session is not what it asks. (It is refused for what this computer's resolver says, or cannot resolve.)
  expect(byName.detail, 'and the refusal is not T20\'s').not.toMatch(/system proxy/)
  expect(socks.requests.length, 'the tunnel saw nothing more').toBe(seen)
  expect(decoy.connections()).toBe(0)

  const loopback = await tcp('127.0.0.1', loopbackEcho.port)
  expect(loopback, 'this computer is reached directly').toMatchObject({ ok: true, detail: 'ping' })
  expect(socks.requests.length).toBe(seen)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-app-follows-the-default] switched on again, the app follows the default and dials through the tunnel once more', async () => {
  const settings = await openApps()
  await settings.locator(ROUTE_CHOICE).selectOption('socks5')
  await settings.close()
  expect(await waitFor(async () => (await tcp(NAME, decoy.port).catch((): Attempt => ({ ok: false, detail: '' }))).ok), 'it reaches the real server through the tunnel again').toBe(true)
  expect(decoy.connections()).toBe(0)
}, 3 * QA_TEST_TIMEOUT_MS)
