// Global Privacy Control in the running shell, measured on the wire and in the page: the `Sec-GPC` header a
// loopback fixture receives and `navigator.globalPrivacyControl` agree, on and off, in a tab, an iframe, a dedicated,
// a shared and a service worker, a private window and a session partition of its own. The signal is the engine's, read
// when the process starts, so each choice is its own launch.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Frame, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, visit } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const KEY = 'privacy.globalPrivacyControl'

interface Seen { readonly path: string, readonly headers: IncomingHttpHeaders }

const WORKER = `fetch('/worker-ping').then(() => postMessage(navigator.globalPrivacyControl))`
const SHARED_WORKER = `onconnect = (event) => { fetch('/shared-ping').then(() => event.ports[0].postMessage(navigator.globalPrivacyControl)) }`
const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()))
self.addEventListener('message', (event) => event.source.postMessage(navigator.globalPrivacyControl))`

let server: Server
let origin = ''
let seen: Seen[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    seen.push({ path, headers: request.headers })
    const script = { '/w.js': WORKER, '/shared.js': SHARED_WORKER, '/sw.js': SERVICE_WORKER }[path]
    if (script !== undefined) { response.setHeader('content-type', 'text/javascript'); response.end(script); return }
    if (path === '/favicon.ico') { response.statusCode = 404; response.end(); return }
    response.setHeader('content-type', 'text/html')
    response.end(path === '/frame' ? '<!doctype html><title>frame</title><p>frame</p>' : '<!doctype html><title>gpc</title><iframe src="/frame"></iframe>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

beforeEach(() => { seen = [] })

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const seedSetting = (value: boolean | undefined) => async (dir: string): Promise<void> => {
  if (value === undefined) return
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { [KEY]: value } }))
}

/** What one document reports about the property, and what its own workers read. */
async function inContext (where: Page | Frame, workers: boolean): Promise<Record<string, unknown>> {
  return await where.evaluate(async (withWorkers) => {
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'globalPrivacyControl')
    const out: Record<string, unknown> = {
      value: (navigator as unknown as { globalPrivacyControl?: unknown }).globalPrivacyControl,
      // A getter on the prototype with no setter, as a built-in one is, and nothing on the navigator itself.
      accessor: descriptor !== undefined && typeof descriptor.get === 'function' && descriptor.set === undefined,
      nativeCode: descriptor?.get !== undefined && Function.prototype.toString.call(descriptor.get).includes('[native code]'),
      ownOnNavigator: Object.prototype.hasOwnProperty.call(navigator, 'globalPrivacyControl')
    }
    if (!withWorkers) return out
    out['dedicated'] = await new Promise((resolve) => { const w = new Worker('/w.js'); w.onmessage = (event) => { resolve(event.data) } })
    out['shared'] = await new Promise((resolve) => { const w = new SharedWorker('/shared.js'); w.port.onmessage = (event) => { resolve(event.data) } })
    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    out['service'] = await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('message', (event) => { resolve(event.data) }, { once: true })
      registration.active?.postMessage('ask')
    })
    await registration.unregister()
    return out
  }, workers)
}

const headerOf = (path: string): string | string[] | undefined => seen.find((entry) => entry.path === path)?.headers['sec-gpc']

/** Every context of a tab on the fixture reports `expected`, and the requests it made carry the header exactly when it is true. */
async function expectSignal (tab: Page, expected: boolean): Promise<void> {
  const top = await inContext(tab, true)
  expect(await waitFor(() => tab.frames().some((frame) => frame.url() === `${origin}/frame`))).toBe(true)
  const frame = tab.frames().find((candidate) => candidate.url() === `${origin}/frame`) as Frame
  const framed = await inContext(frame, false)
  for (const context of [top, framed]) {
    expect(context).toMatchObject({ value: expected, accessor: true, nativeCode: true, ownOnNavigator: false })
  }
  expect([top['dedicated'], top['shared'], top['service']]).toEqual([expected, expected, expected])
  const wanted = expected ? '1' : undefined
  for (const path of ['/', '/frame', '/w.js', '/worker-ping', '/shared.js', '/shared-ping', '/sw.js']) expect([path, headerOf(path)]).toEqual([path, wanted])
}

async function runCase (options: { setting: boolean | undefined, expected: boolean, args?: string[] }): Promise<void> {
  const { app } = await launchedAndVisited(options)
  await closeElectron(app)
}

async function launchedAndVisited (options: { setting: boolean | undefined, expected: boolean, args?: string[] }): Promise<{ app: ElectronApplication, tab: Page }> {
  const { app, chrome } = await launchShell({ seedProfile: seedSetting(options.setting), args: options.args ?? [] })
  try {
    const tab = await visit(app, chrome, `${origin}/`)
    await expectSignal(tab, options.expected)
    return { app, tab }
  } catch (error) {
    await closeElectron(app)
    throw error
  }
}

describe('Global Privacy Control', () => {
  it('is on for a profile that never chose, in a tab, an iframe and every kind of worker, and the header agrees', async () => {
    await runCase({ setting: undefined, expected: true })
  }, TEST_TIMEOUT_MS)

  it('is on when it was chosen on, and a session partition of its own sends it too', async () => {
    const { app } = await launchedAndVisited({ setting: true, expected: true })
    try {
      const partitioned = await app.evaluate(async ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:gpc-e2e', sandbox: true } })
        try {
          await win.loadURL(url)
          return await win.webContents.executeJavaScript('navigator.globalPrivacyControl')
        } finally { win.destroy() }
      }, `${origin}/partition`)
      expect(partitioned).toBe(true)
      expect(headerOf('/partition')).toBe('1')
    } finally {
      await closeElectron(app)
    }
  }, TEST_TIMEOUT_MS)

  it('is off, as false and with no header, in every one of those contexts when it was chosen off', async () => {
    const { app } = await launchedAndVisited({ setting: false, expected: false })
    try {
      const partitioned = await app.evaluate(async ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:gpc-e2e', sandbox: true } })
        try {
          await win.loadURL(url)
          return await win.webContents.executeJavaScript('navigator.globalPrivacyControl')
        } finally { win.destroy() }
      }, `${origin}/partition`)
      expect(partitioned).toBe(false)
      expect(headerOf('/partition')).toBeUndefined()
    } finally {
      await closeElectron(app)
    }
  }, TEST_TIMEOUT_MS)

  it('follows the profile into a private window, on and off', async () => {
    await runCase({ setting: undefined, expected: true, args: ['--orivon-private'] })
    await runCase({ setting: false, expected: false, args: ['--orivon-private'] })
  }, TEST_TIMEOUT_MS * 2)
})
