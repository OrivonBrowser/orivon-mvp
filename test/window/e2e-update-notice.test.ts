// A newer Orivon release is announced inside the browser: once per version, in the window in use, with the question
// panel under the address bar, and never as an operating-system box or notification. GitHub is replaced by the test
// seam (ORIVON_TEST_UPDATE_RELEASE) and the look runs when a case asks (`__orivonDevUpdateCheckNow`), since every
// test launch forces the checks off. The release page is asserted by its address: the network is a black hole.
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { focusWebContents, underVirtualDisplay } from '../support/focus-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const TAG = 'v99.0.0'
const RELEASE_PAGE = `https://github.com/OrivonBrowser/orivon-mvp/releases/tag/${TAG}`
const FILE = 'update-check-state.json'

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Update fixture</title><body style="font:16px sans-serif"><h1>Update fixture</h1></body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface State { lastCheckedAt?: number, lastFoundVersion?: string, lastNotifiedVersion?: string }
interface Launched { app: ElectronApplication, chrome: Page, userData: string, state: () => State | undefined }

/** Starts with the page in front given the keyboard, as a window in use is, unless `inUse` is false. */
async function launched (options: { inUse?: boolean, args?: string[], reuseProfile?: string } = {}): Promise<Launched> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    env: { ORIVON_TEST_UPDATE_RELEASE: TAG },
    ...(options.reuseProfile === undefined ? {} : { reuseProfile: options.reuseProfile })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  await stubNativeDialogs(app)
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
  const state = (): State | undefined => existsSync(join(userData, FILE)) ? JSON.parse(readFileSync(join(userData, FILE), 'utf8')) as State : undefined
  if (options.inUse !== false) {
    await clickAddressBarRetrying(chrome, `${origin}/`)
    expect((await waitForTab(chrome, { address: `${origin}/` })).ok).toBe(true)
    await focusWebContents(app, `${origin}/`)
  }
  return { app, chrome, userData, state }
}

/** Runs one scheduled look and resolves when it is done. It asks the person, so it resolves once the question is answered. */
const lookStarted = async (app: ElectronApplication): Promise<void> => {
  await app.evaluate(() => { void (globalThis as unknown as { __orivonDevUpdateCheckNow?: () => Promise<void> }).__orivonDevUpdateCheckNow?.() })
}

/** Runs one scheduled look and waits for it: for a case where no question is to appear. */
const lookDone = async (app: ElectronApplication): Promise<void> => {
  await app.evaluate(async () => { await (globalThis as unknown as { __orivonDevUpdateCheckNow?: () => Promise<void> }).__orivonDevUpdateCheckNow?.() })
}

async function openSettingsAbout (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/about') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('.layout')
  return page
}

const run = it.skipIf(!underVirtualDisplay())

run('asks in the window in use, in the question panel, and Not now writes the version as told and opens nothing', async () => {
  const { app, state } = await launched()
  try {
    await lookStarted(app)
    const said = await readQuestion(await waitQuestion(app))
    expect(said.title).toBe('Orivon 99.0.0 is available')
    expect(said.message).toMatch(/^You have \d+\.\d+\.\d+/)
    // The way out is drawn first, on the left, as in every question.
    expect(said.buttons).toEqual(['Not now', 'Download from GitHub'])
    // Nothing is told until it was answered: the release is found and kept, not yet told.
    expect(state()?.lastFoundVersion).toBe(TAG)
    expect(state()?.lastNotifiedVersion).toBeUndefined()
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect((await waitForTab(findChrome(app), { address: `${origin}/` })).ok).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).toContain('[self-update] release found: v99.0.0')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('Download from GitHub opens the release page in a new Orivon tab of that window', async () => {
  const { app, chrome, state } = await launched()
  try {
    await lookStarted(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Download from GitHub')
    expect((await waitForTab(chrome, { address: RELEASE_PAGE })).ok).toBe(true)
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('does not ask again about a version it has told, after a relaunch on the same profile', async () => {
  const first = await launched()
  let profile = ''
  try {
    await lookStarted(first.app)
    await waitQuestion(first.app)
    await answerQuestion(first.app, 'Not now')
    expect(await waitFor(() => first.state()?.lastNotifiedVersion === TAG)).toBe(true)
    profile = first.userData
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }
  const second = await launched({ reuseProfile: profile })
  try {
    await lookDone(second.app)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(second.app)).toBe(true)
    expect(second.state()?.lastNotifiedVersion).toBe(TAG)
    expect(await noNativeDialogs(second.app)).toEqual([])
  } finally {
    await closeElectron(second.app)
  }
}, TEST_TIMEOUT_MS)

run('waits while no window is in use, asks nothing and opens no native box, then asks once the window is back', async () => {
  const { app, state } = await launched()
  try {
    await app.evaluate(({ BaseWindow }) => { for (const window of BaseWindow.getAllWindows()) window.hide() })
    await lookDone(app)
    expect(state()?.lastFoundVersion).toBe(TAG)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    expect(state()?.lastNotifiedVersion).toBeUndefined()
    expect(await noNativeDialogs(app)).toEqual([])

    await app.evaluate(({ BaseWindow }) => { for (const window of BaseWindow.getAllWindows()) window.show() })
    await focusWebContents(app, `${origin}/`)
    // The retry that runs while a release waits for a window finds it, with no second look.
    const said = await readQuestion(await waitQuestion(app, 40_000))
    expect(said.title).toBe('Orivon 99.0.0 is available')
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).toContain('[self-update] waiting for a window in use')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('shows the release in Settings > About without pressing Check, when found in the background, and opens its page from there', async () => {
  const { app, chrome } = await launched({ inUse: false })
  try {
    const settings = await openSettingsAbout(app, chrome)
    await settings.waitForSelector('#row-updates-check')
    expect(await settings.locator('#row-updates-release').count()).toBe(0)

    await lookDone(app)
    await settings.waitForSelector('#row-updates-release')
    expect(await settings.locator('#row-updates-release').textContent()).toContain('Orivon 99.0.0 is available.')

    // A Settings page opened later reads the same release on load, with no Check pressed.
    await settings.reload()
    await settings.waitForSelector('#row-updates-release')

    await settings.click('#row-updates-release button')
    expect((await waitForTab(chrome, { address: RELEASE_PAGE })).ok).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('never looks or asks from a private session', async () => {
  const { app } = await launched({ args: ['--orivon-private'] })
  try {
    expect(await app.evaluate(() => typeof (globalThis as unknown as { __orivonDevUpdateCheckNow?: unknown }).__orivonDevUpdateCheckNow)).toBe('undefined')
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
