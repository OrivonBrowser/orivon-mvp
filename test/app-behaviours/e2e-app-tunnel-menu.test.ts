// An installed app is sent through a tunnel from the same menu a website uses, and the choice behaves as a website's does:
// the tunnel button opens the same two rows, turning the proxy on asks no storage question (an app keeps its own session),
// the app reloads and then dials by name through the proxy with its own sign-in, and turning the lit switch off sends it
// through none. The fixture app is served from the loader's cache; every name it dials has a decoy on the same port on
// loopback, so a dial that skipped the proxy would land on it.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-tunnel-menu.test.ts
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
import { delay, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'
import type { Attempt } from './routed-network-entry.js'

const ORIGIN = 'https://app-tunnel-menu-e2e.orivon.test'
const NAME = 'tcp.menu.test'

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
const cleanups: Array<() => Promise<void> | void> = []
const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-app-tunnel-menu-e2e-'))
  decoy = await counting()
  echo = await counting((socket) => { socket.on('data', (chunk) => socket.write(chunk)) })
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: echo.port } } })
  cleanups.push(async () => { await decoy.close() }, async () => { await echo.close() }, async () => { await socks.close() }, () => { rmSync(dir, { recursive: true, force: true }) })

  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./routed-network-entry.ts', import.meta.url))))
  const launched = await launchShell({
    seedProfile: async (userDataDir) => {
      // The proxy's address is saved; nothing goes through a tunnel yet.
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
  app = launched.app
  chrome = launched.chrome

  const connect = [`${NAME}:${String(decoy.port)}`]
  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.behaviour.app-tunnel-menu',
    name: 'Behaviour app-tunnel-menu',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { net: { tcp: { connect } } }
  }
  const served = await serveApp(app, ORIGIN, manifest, 'tcp.connect', {
    '/index.html': new TextEncoder().encode('<!doctype html><title>app tunnel menu</title><body><script src="/app.js"></script></body>'),
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

async function tcp (): Promise<Attempt> {
  return await view.evaluate(async ({ host, port }) => {
    const entry = (globalThis as unknown as { routedNetworkE2e: { tcp: (host: string, port: number) => Promise<unknown> } }).routedNetworkE2e
    return await entry.tcp(host, port)
  }, { host: NAME, port: decoy.port }) as Attempt
}

async function openPopover (): Promise<Page> {
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  return popover
}

const dialed = (): boolean => socks.requests.some((request) => request.destination === NAME && request.port === decoy.port && request.addressType === 'domain')

it('[app:app-tunnel-from-the-menu] an installed app has the same two rows as a website, both off, and its name is not dialled anywhere', async () => {
  expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible()), 'the tunnel button is on an app\'s page').toBe(true)
  const popover = await openPopover()
  expect(await popover.locator('.tunnel-row').count()).toBe(2)
  expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('false')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('false')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-label')).toBe('Use your proxy for this app')
  const attempt = await tcp()
  expect(attempt.ok, 'with no tunnel this computer cannot resolve the name').toBe(false)
  expect(dialed()).toBe(false)
  expect(decoy.connections()).toBe(0)
  await shoot(app, chrome, popover, 'app-tunnel-menu')
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(300)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:app-tunnel-from-the-menu] turning the proxy on asks no storage question, reloads the app, and it dials through the proxy with its own sign-in and never reaches the decoy', async () => {
  const popover = await openPopover()
  await popover.click('#tunnel-switch-socks5')
  // A website would ask here, before it moves into a profile; an app keeps its own session, so the switch applies at once (and the popover goes with the reload).
  expect(await popover.locator('.tunnel-notice').count().catch(() => 0), 'no storage question').toBe(0)
  expect(await waitFor(async () => (await tcp().catch((): Attempt => ({ ok: false, detail: '' }))).ok, 60_000), 'the app reaches the real server through the proxy').toBe(true)
  expect(dialed(), 'the name was asked of the proxy, unresolved').toBe(true)
  expect(socks.requests.find((request) => request.destination === NAME)?.userId, 'with the app\'s own sign-in').toBeDefined()
  expect(decoy.connections()).toBe(0)
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on')).toBe(true)
  expect(await chrome.getAttribute('#tunnel-btn', 'aria-label')).toContain('This page goes through your proxy')
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:app-tunnel-from-the-menu] the menu shows the proxy on for the app, says its updates are not checked, and turning the lit switch off sends it through none', async () => {
  if (findPopup() !== undefined) await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(300)
  const popover = await openPopover()
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('true')
  expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('false')
  expect(await popover.locator('.tunnel-section').textContent()).toContain('Its updates are not checked while it goes through a tunnel.')
  await popover.click('#tunnel-switch-socks5')
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null), 'the button is grey again').toBe(true)
  const seen = socks.requests.length
  expect(await waitFor(async () => !(await tcp().catch((): Attempt => ({ ok: true, detail: '' }))).ok, 60_000), 'the app no longer reaches the real server').toBe(true)
  expect(socks.requests.length, 'and the proxy is asked nothing more').toBe(seen)
  expect(decoy.connections()).toBe(0)
}, 4 * QA_TEST_TIMEOUT_MS)
