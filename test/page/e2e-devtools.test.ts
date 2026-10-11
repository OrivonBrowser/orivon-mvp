// Developer tools for the pages a tab shows: their key (F12, Command+Option+I on macOS) and Mod+Shift+I open and
// close them on a website, the setting turns them off, the shell's own pages
// stay closed to them, and an app that holds permissions asks once before they
// open.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, pressBinding, pressCommand, pressKey } from '../support/e2e-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'

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

it('opens and closes on its key and on Mod+Shift+I, and closes when they are turned off', async () => {
  const { app, chrome } = await launched()
  try {
    const address = `${siteOrigin}/page`
    await open(app, chrome, address)
    expect(await toolsOpenAt(app, address)).toBe(false)

    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === false)).toBe(true)

    await pressBinding(app, address, 'Mod+Shift+I')
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
    await pressCommand(app, address, 'devtools.toggle')
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
    await pressCommand(app, 'orivon://settings', 'devtools.toggle')
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

    await stubNativeDialogs(app)
    const address = `${appOrigin}/app`
    await open(app, chrome, address)

    // The question is drawn in the tab. A key typed at the page does not answer it, and Cancel opens nothing.
    await pressCommand(app, address, 'devtools.toggle')
    const question = await readQuestion(await waitQuestion(app))
    expect(question.message).toContain(appOrigin)
    expect(question.buttons).toEqual(['Cancel', 'Open developer tools'])
    await pressKey(app, address, 'Enter')
    await delay(400)
    expect(await questionGone(app)).toBe(false)
    expect(await toolsOpenAt(app, address)).toBe(false)
    await answerQuestion(app, 'Cancel')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect(await toolsOpenAt(app, address)).toBe(false)

    // Open: they open, and closing and opening again does not ask again.
    await pressCommand(app, address, 'devtools.toggle')
    await answerQuestion(app, 'Open developer tools')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === false)).toBe(true)
    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    expect(await questionGone(app)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// Closing the tools destroys their own webContents; inside the key event's delivery that is a CHECK in
// ~WebContentsImpl that ends the main process, so a key's command must have returned before the tools open
// or close. Observed from the main process: a listener placed before and one after the shortcut dispatcher's
// mark the span of the event.
type ToolCall = { call: string, inside: boolean }

async function recordToolCalls (app: ElectronApplication, address: string): Promise<void> {
  await app.evaluate(({ webContents }, part) => {
    const state = globalThis as unknown as { __insideKey: boolean, __calls: ToolCall[] }
    state.__insideKey = false
    state.__calls = []
    const contents = webContents.getAllWebContents().find((c) => c.getURL().includes(part))
    if (contents === undefined) throw new Error('no page')
    contents.prependListener('before-input-event', () => { state.__insideKey = true })
    contents.on('before-input-event', () => { state.__insideKey = false })
    for (const call of ['openDevTools', 'closeDevTools'] as const) {
      const original = contents[call].bind(contents) as (...args: unknown[]) => void
      ;(contents as unknown as Record<string, unknown>)[call] = (...args: unknown[]) => {
        state.__calls.push({ call, inside: state.__insideKey })
        original(...args)
      }
    }
  }, address)
}

const toolCalls = async (app: ElectronApplication): Promise<ToolCall[]> =>
  await app.evaluate(() => (globalThis as unknown as { __calls: ToolCall[] }).__calls)

/** The page's own size, and the side its tools' frontend says they are docked on. */
async function dockedAt (app: ElectronApplication, address: string): Promise<{ size: string, side: unknown }> {
  return await app.evaluate(async ({ webContents }, part) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().includes(part))
    const size = await contents?.executeJavaScript('[innerWidth, innerHeight].join("x")') as string
    const side = await contents?.devToolsWebContents?.executeJavaScript(`import('./ui/legacy/legacy.js').then((m) => m.DockController.DockController.instance().dockSide())`).catch(() => null)
    return { size, side }
  }, address)
}

// The shell's window draws its own title bar controls, and Electron undocks tools asked to dock on the right of
// such a window: "Beside the page" must still dock them there (src/main/devtools/dock-side.ts).
for (const [dock, side, shrinks] of [['right', 'right', 0], ['bottom', 'bottom', 1]] as const) {
  it(`docks the tools ${dock === 'right' ? 'beside' : 'under'} the page, inside the window, when the setting says so`, async () => {
    const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'developer.dock': dock } })) })
    try {
      const address = `${siteOrigin}/page`
      await open(app, chrome, address)
      const before = (await dockedAt(app, address)).size.split('x').map(Number)
      await pressCommand(app, address, 'devtools.toggle')
      expect(await waitFor(async () => (await dockedAt(app, address)).side === side, 8_000)).toBe(true)
      const after = (await dockedAt(app, address)).size.split('x').map(Number)
      expect(after[shrinks], `the page gives the tools room: ${String(before)} -> ${String(after)}`).toBeLessThan(before[shrinks] as number)
      expect(after[1 - shrinks]).toBe(before[1 - shrinks])
    } finally {
      await closeElectron(app)
    }
  }, TEST_TIMEOUT_MS)
}

it('opens and closes the tools after the key event has returned, never inside it', async () => {
  const { app, chrome } = await launched()
  try {
    const address = `${siteOrigin}/page`
    await open(app, chrome, address)
    await recordToolCalls(app, address)
    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === false)).toBe(true)
    expect(await toolCalls(app)).toEqual([{ call: 'openDevTools', inside: false }, { call: 'closeDevTools', inside: false }])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('closes the tools of a tab closed with Mod+W after the key event has returned, never inside it', async () => {
  const { app, chrome } = await launched()
  try {
    const address = `${siteOrigin}/page`
    await open(app, chrome, address)
    await recordToolCalls(app, address)
    await pressCommand(app, address, 'devtools.toggle')
    expect(await waitFor(async () => await toolsOpenAt(app, address) === true)).toBe(true)
    await pressCommand(app, address, 'tab.close')
    expect(await waitFor(async () => (await toolsOpenAt(app, address)) !== true && (await toolCalls(app)).some((c) => c.call === 'closeDevTools'))).toBe(true)
    expect(await toolCalls(app)).toEqual([{ call: 'openDevTools', inside: false }, { call: 'closeDevTools', inside: false }])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
