// Developer tools for the pages a tab shows: F12 and Ctrl+Shift+I open and
// close them on a website, the setting turns them off, the shell's own pages
// stay closed to them, and an app that holds permissions asks once before they
// open.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const servers: Server[] = []
let siteOrigin = ''
let appOrigin = ''

async function serve (): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>a site</title><p>a site</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(server)
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

beforeAll(async () => {
  siteOrigin = await serve()
  appOrigin = await serve()
})

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

async function launched (seed?: (dir: string) => Promise<void>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(seed === undefined ? {} : { seedProfile: seed }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const toolsOpenAt = async (app: ElectronApplication, urlPart: string): Promise<boolean | null> =>
  await app.evaluate(({ webContents }, part) => webContents.getAllWebContents().find((contents) => contents.getURL().includes(part))?.isDevToolsOpened() ?? null, urlPart)

async function open (app: ElectronApplication, chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

it('opens and closes on F12 and Ctrl+Shift+I, and closes when they are turned off', async () => {
  const { app, chrome } = await launched()
  try {
    const address = `${siteOrigin}/page`
    await open(app, chrome, address)
    expect(await toolsOpenAt(app, address)).toBe(false)

    await pressKey(app, address, 'F12')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    await pressKey(app, address, 'F12')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === false)).toBe(true)

    await pressKey(app, address, 'I', ['control', 'shift'])
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)

    // Turning the setting off in Settings closes the ones that are open.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/developer') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await settings.waitForSelector('#row-developer-tools')
    await settings.locator('#row-developer-tools input[type=checkbox]').click()
    expect(await waitFor(async () => await toolsOpenAt(app, address) === false)).toBe(true)
    await settings.waitForSelector('#row-developer-dock', { state: 'detached' })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does nothing when the setting is off', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'developer.tools': false } }))
  })
  try {
    const address = `${siteOrigin}/off`
    await open(app, chrome, address)
    await pressKey(app, address, 'F12')
    await delay(500)
    expect(await toolsOpenAt(app, address)).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps Settings closed to developer tools', async () => {
  const { app, chrome } = await launched()
  try {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('settings') })
    expect(await waitFor(async () => await toolsOpenAt(app, 'orivon://settings') === false)).toBe(true)
    await pressKey(app, 'orivon://settings', 'F12')
    await delay(500)
    expect(await toolsOpenAt(app, 'orivon://settings')).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.devtools-e2e',
    name: 'Developer tools e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: [],
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
}

it('asks once before opening them on an app that holds permissions, and not again for the same app', async () => {
  const { app, chrome } = await launched()
  try {
    const registered = await app.evaluate(async (_electron, request: DevGrantRequest) => {
      const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
      if (typeof hook !== 'function') return false
      await hook(request)
      return true
    }, { origin: appOrigin, manifest: manifest(), capability: 'tcp.connect', patterns: ['127.0.0.1:9'] } satisfies DevGrantRequest)
    expect(registered).toBe(true)

    // The question is a native dialog no driver can answer: the answers are given here, and counted.
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { __asked: string[], __answer: number }
      state.__asked = []
      state.__answer = 1
      dialog.showMessageBoxSync = ((_window: unknown, options: { message: string }) => {
        state.__asked.push(options.message)
        return state.__answer
      }) as unknown as typeof dialog.showMessageBoxSync
    })
    const asked = async (): Promise<string[]> => await app.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked)

    const address = `${appOrigin}/app`
    await open(app, chrome, address)

    // Cancel: nothing opens.
    await pressKey(app, address, 'F12')
    expect(await waitFor(async () => (await asked()).length === 1)).toBe(true)
    expect((await asked())[0]).toContain(appOrigin)
    expect(await toolsOpenAt(app, address)).toBe(false)

    // Open: they open, and closing and opening again does not ask again.
    await app.evaluate(() => { (globalThis as unknown as { __answer: number }).__answer = 0 })
    await pressKey(app, address, 'F12')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    expect((await asked()).length).toBe(2)
    await pressKey(app, address, 'F12')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === false)).toBe(true)
    await pressKey(app, address, 'F12')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    expect((await asked()).length).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
