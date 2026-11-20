// The browser shows itself before it may load a web page. The test seam holds the gate on web pages shut for a while after
// the start-up work (ORIVON_TEST_WEB_READY_DELAY_MS), so each spec looks at the gap: the window visible and its chrome
// painted, an address typed or restored or handed over by a second start not requested from the server until the gate
// opens, an enabled extension loaded before the first request, and the previous session left alone until it is restored.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput, profileDirOf } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { html, launchShell, startServer, type FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, HERMETIC_RESOLVER, waitFor, waitForChromeView, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 180_000
/** Long enough that a spec reads the whole gap, and the gate is still shut when it has. */
const HOLD_MS = 14_000
const UBLOCK_ORIGIN_ID = 'fkgkibajhfbepljeaefdnfnegdcjomkh'
const electronBinary = createRequire(import.meta.url)('electron') as string

let server: FixtureServer
/** Every path the fixture server was asked for, in order. */
let requests: string[] = []
/** What the main process held when a path was asked for: the ids of the extensions loaded in the default session. */
let extensionsWhenAsked: string[] | undefined
let askedApp: ElectronApplication | undefined

beforeAll(async () => {
  server = await startServer((request, response) => {
    const path = request.url ?? '/'
    requests.push(path)
    const app = askedApp
    const answer = (): void => { html(response, `<!doctype html><meta charset="utf-8"><title>page ${path.slice(1)}</title><p>${path}</p>`) }
    if (app === undefined || extensionsWhenAsked !== undefined) { answer(); return }
    app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().map((extension) => extension.id))
      .then((ids) => { extensionsWhenAsked = ids }, () => { extensionsWhenAsked = [] })
      .finally(answer)
  })
})
beforeEach(() => { requests = []; extensionsWhenAsked = undefined; askedApp = undefined })
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const url = (name: string): string => `${server.origin}/${name}`
const hold = { ORIVON_TEST_WEB_READY_DELAY_MS: String(HOLD_MS) }

/** Whether the gate on web pages is open now, asked of the main process. */
const gateOpen = async (app: ElectronApplication): Promise<boolean> => await app.evaluate(async () => {
  const webReady = globalThis.__orivonDevStartup?.webReady
  return webReady === undefined ? true : await Promise.race([webReady.then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 0) })])
})
const untilGateOpens = async (app: ElectronApplication): Promise<void> => { await app.evaluate(async () => { await globalThis.__orivonDevStartup?.webReady }) }
const visibleWindows = async (app: ElectronApplication): Promise<boolean[]> => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((window) => window.isVisible()))
const titles = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('.tab .title')).map((el) => el.textContent ?? ''))

interface Startup { complete: boolean, marks: Record<string, number | null> }
const startupLines = (app: ElectronApplication): string[] => mainOutput(app).split('\n').filter((line) => line.startsWith('[orivon][startup] '))
const startupOf = async (app: ElectronApplication): Promise<Startup> => {
  expect(await waitFor(() => startupLines(app).length > 0)).toBe(true)
  expect(startupLines(app)).toHaveLength(1)
  return JSON.parse((startupLines(app)[0] as string).slice('[orivon][startup] '.length)) as Startup
}
const reached = (startup: Startup, name: string): number => {
  const at = startup.marks[name]
  expect(at, `the start-up mark ${name}`).toEqual(expect.any(Number))
  return at as number
}
/** What a start must not print, whatever else it does. */
const expectNoTripwire = (app: ElectronApplication): void => {
  expect(mainOutput(app)).not.toContain('web view made before web content may load')
  expect(mainOutput(app)).not.toContain('uncaught exception')
}

const sessionText = (): string => JSON.stringify({ version: 1, clean: true, windows: [{ active: 0, tabs: [{ url: url('a'), title: 'page a', pinned: false }, { url: url('b'), title: 'page b', pinned: false }] }] })
const seedSession = () => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'startup.mode': 'continue' } }))
  await writeFile(join(dir, 'session.json'), sessionText())
}

/** A launch that ends with the window, not the page: its chrome has no tab yet when the session is restored after the gate. */
async function launchWindowOnly (options: Parameters<typeof launchElectron>[0]): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...options, args: [HERMETIC_RESOLVER, ...(options?.args ?? [])], chrome: false, webReady: false })
  // The helper's JSDoc leaves its result typed as undefined: it is the chrome page.
  const chrome = await waitForChromeView(app) as unknown as Page | undefined
  if (chrome === undefined) throw new Error('the first window has no chrome view')
  await chrome.waitForSelector('#address', { state: 'attached' })
  return { app, chrome }
}

it('shows the browser with its chrome painted while web pages may not load yet, and holds a typed address until they may', async () => {
  const { app, chrome } = await launchShell({ env: hold, webReady: false })
  try {
    expect(await gateOpen(app)).toBe(false)
    expect(await visibleWindows(app)).toEqual([true])
    expect(await waitFor(async () => (await titles(chrome)).join() === 'New Tab')).toBe(true)

    await clickAddressBarRetrying(chrome, url('typed'))
    await delay(ABSENCE_SETTLE_MS)
    expect(requests).toEqual([])
    expect(await gateOpen(app)).toBe(false)

    await untilGateOpens(app)
    expect((await waitForTab(chrome, { address: url('typed') })).ok).toBe(true)
    expect(requests).toEqual(['/typed'])

    const startup = await startupOf(app)
    expect(startup.complete).toBe(true)
    // The page painted and the window showed before the tail ran, and the gate opened after it, a hold later.
    expect(reached(startup, 'chromeReadyToShow')).toBeLessThanOrEqual(reached(startup, 'windowShown'))
    expect(reached(startup, 'windowShown')).toBeLessThanOrEqual(reached(startup, 'afterWindowDone'))
    expect(reached(startup, 'webContentReady') - reached(startup, 'afterWindowDone')).toBeGreaterThanOrEqual(HOLD_MS - 1000)
    expectNoTripwire(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('has the bundled extension loaded before the first web request of a new profile', async () => {
  const { app, chrome } = await launchShell({ env: { ...hold, ORIVON_DEFAULT_PROFILE: 'on' }, sandbox: true, webReady: false })
  try {
    askedApp = app
    expect(await gateOpen(app)).toBe(false)
    expect(await visibleWindows(app)).toEqual([true])

    await clickAddressBarRetrying(chrome, url('first'))
    await delay(ABSENCE_SETTLE_MS)
    expect(requests).toEqual([])

    await untilGateOpens(app)
    expect(await waitFor(() => requests.length > 0 && extensionsWhenAsked !== undefined)).toBe(true)
    expect(extensionsWhenAsked).toContain(UBLOCK_ORIGIN_ID)

    const startup = await startupOf(app)
    expect(reached(startup, 'extensionsSeeded')).toBeLessThanOrEqual(reached(startup, 'afterWindowDone'))
    expect(reached(startup, 'windowShown')).toBeLessThanOrEqual(reached(startup, 'extensionsSeedStart'))
    expectNoTripwire(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('restores the last session only once web pages may load, with the window and its toolbar there before, and the session file as it was', async () => {
  const { app, chrome } = await launchWindowOnly({ env: hold, seedProfile: seedSession() })
  try {
    const dir = profileDirOf(app) as string
    expect(await gateOpen(app)).toBe(false)
    expect(await visibleWindows(app)).toEqual([true])
    expect(await titles(chrome)).toEqual([])
    // Past the session store's write delay: a window with no tab yet must not have replaced the file.
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(requests).toEqual([])
    expect(await gateOpen(app)).toBe(false)
    expect(await readFile(join(dir, 'session.json'), 'utf8')).toBe(sessionText())

    await untilGateOpens(app)
    expect(await waitFor(async () => (await titles(chrome)).join('|') === 'page a|page b')).toBe(true)
    expect([...requests].sort()).toEqual(['/a', '/b'])
    expect(await visibleWindows(app)).toEqual([true])

    // The tabs are the session now, and the line is printed once with the front tab loaded.
    const startup = await startupOf(app)
    expect(startup.complete).toBe(true)
    expect(reached(startup, 'webContentReady')).toBeLessThanOrEqual(reached(startup, 'firstTabLoaded'))
    expectNoTripwire(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps the previous session when the browser is closed while the window waits to restore it', async () => {
  const { app } = await launchWindowOnly({ env: hold, seedProfile: seedSession() })
  const dir = profileDirOf(app) as string
  try {
    expect(await gateOpen(app)).toBe(false)
    await delay(ABSENCE_SETTLE_MS * 2)
  } finally {
    await closeElectron(app, { keepProfile: true })
  }
  try {
    expect(await readFile(join(dir, 'session.json'), 'utf8')).toBe(sessionText())
    expect(requests).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

/** Starts Orivon on the profile `dir` the way a click on a link does, and answers how it ended: the running one takes the request and this one exits. */
async function secondStart (args: string[], dir: string): Promise<number | null> {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronBinary, ['.', `--user-data-dir=${dir}`, '--no-sandbox', ...args], { env, stdio: 'ignore' })
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

it('answers a second start made during the gap once, with one window, after web pages may load', async () => {
  const { app, chrome } = await launchShell({ env: hold, webReady: false })
  try {
    const dir = profileDirOf(app) as string
    expect(await gateOpen(app)).toBe(false)
    expect(await secondStart([url('second')], dir)).toBe(0)
    await delay(ABSENCE_SETTLE_MS)
    expect(await gateOpen(app)).toBe(false)
    expect(requests).toEqual([])
    expect(await visibleWindows(app)).toEqual([true])

    await untilGateOpens(app)
    expect((await waitForTab(chrome, { address: url('second') })).ok).toBe(true)
    expect(requests).toEqual(['/second'])
    expect(await visibleWindows(app)).toEqual([true])
    expectNoTripwire(app)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
