// An installed app the person routed with the built-in Nym tunnel (the default choice) sends its connections through
// the Nym host, which carries them through a tunnel of the app's own. The module is a stand-in with the same exports
// that connects to local servers and writes a log line for everything it is asked, so the log says what went where.
// Every name the app dials has a decoy on the same port on loopback: this machine answers an unknown name with a
// loopback address, so a dial that skipped Nym would land on a decoy, and a decoy that counts a connection fails
// the test. With a module that cannot start, the app fails closed: nothing answers, nothing goes anywhere else.
//
// Run it with the e2e build (scripts/build-e2e.mjs), then through scripts/run-headless.mjs with vitest and
// test/vitest.e2e.config.ts.
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, waitForPageGlobal } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { bundleForApp, serveApp } from '../node-runtime/pinned-app.js'
import type { Attempt } from './routed-network-entry.js'

const ORIGIN = 'https://routed-nym-e2e.orivon.test'
const SETTINGS_URL_PREFIX = 'orivon://settings'
const ROUTE_SWITCH = '.app-card:has-text("routed-nym-e2e") .app-route .switch'
const EMPTY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

/** The stand-in module. It reads its targets and its log from the file the test names, at each use. */
const FAKE_MODULE = `
import net from 'node:net'
import dgram from 'node:dgram'
import fs from 'node:fs'
const config = () => JSON.parse(fs.readFileSync(process.env.ORIVON_TEST_NYM_FAKE, 'utf8'))
const log = (line) => fs.appendFileSync(config().log, line + '\\n')
let client = ''
export function initSync () {}
export function main () {}
export async function setupMixTunnel (options) {
  if (config().failStart) throw new Error('the stand-in gateway is unreachable')
  client = options.clientId.replace(/-[0-9a-f]{12}$/, '')
  log('up ' + client)
}
export async function disconnectMixTunnel () { log('down ' + client) }
export async function connectTcp (host, port) {
  const target = config().targets[host + ':' + port]
  if (target === undefined) throw new Error('no such name')
  log('tcp ' + client + ' ' + host + ':' + port)
  const socket = net.connect(target.port, target.host)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const chunks = []
  let wake
  socket.on('data', (data) => { chunks.push(new Uint8Array(data)); wake?.() })
  socket.on('close', () => { chunks.push(null); wake?.() })
  socket.on('error', () => {})
  return {
    read: async () => { while (chunks.length === 0) await new Promise((resolve) => { wake = resolve }); return chunks.shift() },
    write: async (bytes) => { socket.write(bytes) },
    close: async () => { socket.end() }
  }
}
export async function bindUdp () {
  const queue = []
  let wake
  let closed = false
  const socket = dgram.createSocket('udp4')
  return {
    sendTo: async (host, port, bytes) => {
      const target = config().targets[host + ':' + port]
      if (target === undefined) throw new Error('no such name')
      log('udp ' + client + ' ' + host + ':' + port)
      socket.once('message', (data) => { queue.push({ data: new Uint8Array(data), host: '203.0.113.9', port }); wake?.() })
      socket.send(bytes, target.port, target.host)
    },
    recv: async (timeoutMs) => {
      const deadline = Date.now() + (timeoutMs ?? 60000)
      while (queue.length === 0) {
        if (closed) throw new Error('UDP socket closed')
        if (Date.now() > deadline) throw new Error('UDP receive timed out')
        await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 50) })
      }
      return queue.shift()
    },
    close: () => { closed = true; try { socket.close() } catch {} }
  }
}
`

interface Counting { readonly port: number, readonly connections: () => number, readonly close: () => Promise<void> }

async function counting (onConnection?: (socket: Socket) => void): Promise<Counting> {
  const open = new Set<Socket>()
  let connections = 0
  const server: Server = createTcpServer((socket) => {
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

interface Scenario {
  readonly app: ElectronApplication
  readonly chrome: Page
  readonly view: Page
  readonly ports: { readonly tcp: number, readonly udp: number }
  readonly log: () => string[]
  readonly directHits: () => number
  readonly settings: (section: 'apps' | 'privacy') => Promise<Page>
  readonly call: (name: 'tcp' | 'datagram', host: string, port: number) => Promise<Attempt>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scenario (failStart: boolean): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-routed-nym-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)

  const decoyTcp = await counting()
  const decoyUdp = createSocket('udp4')
  let udpHits = 0
  decoyUdp.on('message', () => { udpHits += 1 })
  await new Promise<void>((resolve) => { decoyUdp.bind(0, '127.0.0.1', resolve) })
  const echo = await counting((socket) => { socket.on('data', (chunk) => socket.write(chunk)) })
  const udpReal = createSocket('udp4')
  udpReal.on('message', (data, from) => { udpReal.send(data, from.port, from.address) })
  await new Promise<void>((resolve) => { udpReal.bind(0, '127.0.0.1', resolve) })
  cleanups.push(async () => { await decoyTcp.close(); await echo.close(); decoyUdp.close(); udpReal.close() })

  const ports = { tcp: decoyTcp.port, udp: decoyUdp.address().port }
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({
    failStart,
    log: logFile,
    targets: {
      [`tcp.nym.test:${String(ports.tcp)}`]: { host: '127.0.0.1', port: echo.port },
      // The name the Settings page's Test of Nym opens a stream to.
      'example.com:443': { host: '127.0.0.1', port: echo.port },
      [`udp.nym.test:${String(ports.udp)}`]: { host: '127.0.0.1', port: udpReal.address().port }
    }
  }))

  const { app, chrome } = await launchShell({ env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile } })
  cleanups.push(async () => { await app.close().catch(() => {}) })

  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.behaviour.routed-nym',
    name: 'Behaviour routed-nym',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: {
      net: {
        tcp: { connect: [`tcp.nym.test:${String(ports.tcp)}`] },
        udp: { bind: { local: ['47400-47499'] }, send: [`udp.nym.test:${String(ports.udp)}`] }
      }
    }
  }
  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./routed-network-entry.ts', import.meta.url))))
  const served = await serveApp(app, ORIGIN, manifest, 'tcp.connect', {
    '/index.html': new TextEncoder().encode('<!doctype html><title>routed nym</title><body><script src="/app.js"></script></body>'),
    '/app.js': new TextEncoder().encode(script)
  }, manifest.capabilities.net?.tcp?.connect ?? [], [
    { capability: 'udp.bind.local', patterns: ['47400-47499'] },
    { capability: 'udp.send', patterns: [`udp.nym.test:${String(ports.udp)}`] }
  ])
  expect(served).toEqual({ granted: true, registered: true })

  await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
  expect((await waitForTab(chrome, { address: `${ORIGIN}/` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, `${ORIGIN}/`) !== undefined)).toBe(true)
  const view = findViewShowing(app, chrome, `${ORIGIN}/`) as Page
  await view.waitForLoadState('load')
  await waitForPageGlobal(view, 'routedNetworkE2e')

  const settings = async (section: 'apps' | 'privacy'): Promise<Page> => {
    await chrome.evaluate((path) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', path) }, `/${section}`)
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(SETTINGS_URL_PREFIX) && w.url().includes(section)))).toBe(true)
    return app.windows().find((w) => w.url().startsWith(SETTINGS_URL_PREFIX) && w.url().includes(section)) as Page
  }
  return {
    app,
    chrome,
    view,
    ports,
    log: () => readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== ''),
    directHits: () => decoyTcp.connections() + udpHits,
    settings,
    call: async (name, host, port) => await view.evaluate(async ({ method, args }) => {
      const entry = (globalThis as unknown as { routedNetworkE2e: Record<string, (...a: unknown[]) => Promise<unknown>> }).routedNetworkE2e
      return await (entry[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    }, { method: name, args: [host, port] }) as Attempt
  }
}

async function switchRouteOn (scene: Scenario): Promise<void> {
  const apps = await scene.settings('apps')
  await apps.waitForSelector(ROUTE_SWITCH)
  // The switch reloads the app's page; a marker on the page that is there now shows when that happened, which a slow system may do after a wait for the page's global would have returned.
  await scene.view.evaluate(() => { (window as unknown as { routeSwitchMarker: boolean }).routeSwitchMarker = true })
  await apps.locator(ROUTE_SWITCH).click()
  expect(await waitFor(async () => await scene.view.evaluate(() => (window as unknown as { routeSwitchMarker?: boolean }).routeSwitchMarker === undefined).catch(() => false)), 'the app\'s page was reloaded by the switch').toBe(true)
  await scene.view.waitForLoadState('load')
  await waitForPageGlobal(scene.view, 'routedNetworkE2e')
}

it('[app:routed-app-on-nym-sends-nothing-direct] an installed app routed with the built-in Nym tunnel dials by name and by datagram through a Nym tunnel of its own, the Nym host starts at the first connection, and nothing reaches the same address and port directly', async () => {
  const scene = await scenario(false)
  // Nothing is up until the route is on, though the app has been open for a while.
  expect(scene.log(), 'no tunnel before the app is routed').toEqual([])
  // Nym is the default choice and no address is saved: the switch needs nothing set first.
  await switchRouteOn(scene)

  const tcp = await scene.call('tcp', 'tcp.nym.test', scene.ports.tcp)
  expect(tcp, 'connect by name').toMatchObject({ ok: true, detail: 'ping' })
  const datagram = await scene.call('datagram', 'udp.nym.test', scene.ports.udp)
  expect(datagram, 'a datagram by name').toMatchObject({ ok: true, detail: 'ping' })

  const lines = scene.log()
  const clients = new Set(lines.filter((line) => line.startsWith('up ')).map((line) => line.slice(3)))
  expect(clients.size, 'one tunnel for this app').toBe(1)
  expect(clients.values().next().value, 'named by the app\'s isolation user name').toMatch(/^[0-9a-f]{32}$/)
  expect(lines.some((line) => line.startsWith('tcp ') && line.endsWith(` tcp.nym.test:${String(scene.ports.tcp)}`)), 'the name reached the module unresolved').toBe(true)
  expect(lines.some((line) => line.startsWith('udp ') && line.endsWith(` udp.nym.test:${String(scene.ports.udp)}`))).toBe(true)
  expect(scene.directHits(), 'no decoy, on the same ports on loopback, was reached').toBe(0)

  // Settings says so, in the words of the status line.
  const privacy = await scene.settings('privacy')
  await expect.poll(async () => await privacy.locator('#row-route-nym-status').innerText(), { timeout: 10_000 }).toContain('Nym tunnel ready')
  await privacy.locator('#row-route-proxy-test button').click()
  await expect.poll(async () => await privacy.locator('#row-route-proxy-test').innerText(), { timeout: 20_000 }).toContain('Nym answered')
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-on-nym-fails-closed] with a Nym that cannot start, the routed app\'s connections fail, nothing is sent direct, and Settings says Nym is not answering', async () => {
  const scene = await scenario(true)
  await switchRouteOn(scene)

  const attempts = [await scene.call('tcp', 'tcp.nym.test', scene.ports.tcp), await scene.call('datagram', 'udp.nym.test', scene.ports.udp)]
  expect(attempts.map((attempt) => attempt.ok), JSON.stringify(attempts)).toEqual([false, false])
  expect(scene.directHits(), 'nothing went to the decoys').toBe(0)
  expect(scene.log().filter((line) => line.startsWith('tcp ') || line.startsWith('udp ')), 'the module carried nothing').toEqual([])

  const privacy = await scene.settings('privacy')
  await expect.poll(async () => await privacy.locator('#row-route-nym-status').innerText(), { timeout: 10_000 }).toContain('Nym is not answering')
}, 3 * QA_TEST_TIMEOUT_MS)

it('leaves no Electron process behind', async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})
