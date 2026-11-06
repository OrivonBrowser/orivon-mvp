// A newer Orivon release is announced inside the browser: once per version, in the window in use, with the question
// panel under the address bar, and never as an operating-system box or notification. GitHub is replaced by the test
// seam (ORIVON_TEST_UPDATE_RELEASE) and the look runs when a case asks (`__orivonDevUpdateCheckNow`), since every
// test launch forces the checks off. The pages a download button opens (the release page, the start page of
// latest.orivonstack.eth) are asserted by their addresses: the network is a black hole. The "Update Orivon" button on
// the new-tab page follows the release on offer, whether or not the person was told of it.
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
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const TAG = 'v99.0.0'
const RELEASE_PAGE = `https://github.com/OrivonBrowser/orivon-mvp/releases/tag/${TAG}`
const LATEST_PAGE = 'https://latest.orivonstack.eth/'
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
async function launched (options: { inUse?: boolean, args?: string[], reuseProfile?: string, release?: string } = {}): Promise<Launched> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    env: { ORIVON_TEST_UPDATE_RELEASE: options.release ?? TAG },
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

const dashboards = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().includes('/newtab/') && !w.isClosed())

/** Starts on the new tab the window opens with, drawn, and (unless `inUse` is false) with the keyboard in it, as a window in use has. */
async function launchedOnNewTab (options: { inUse?: boolean, release?: string } = {}): Promise<Launched & { dashboard: Page }> {
  const base = await launched({ inUse: false, ...(options.release === undefined ? {} : { release: options.release }) })
  expect(await waitFor(() => dashboards(base.app).length === 1)).toBe(true)
  const dashboard = dashboards(base.app)[0] as Page
  await dashboard.waitForSelector('html[data-settled="1"]')
  if (options.inUse !== false) await focusWebContents(base.app, dashboard.url())
  return { ...base, dashboard }
}

const pillHidden = async (page: Page): Promise<boolean> => await page.evaluate(() => (document.querySelector('#update-pill') as HTMLElement | null)?.hidden ?? true)

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
    expect(said.buttons).toEqual(['Not now', 'Download from GitHub', 'Download from latest.orivonstack.eth'])
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

run('Escape on the drawn panel dismisses it, and the version counts as told because the person saw the question', async () => {
  const { app, state } = await launched()
  try {
    await lookStarted(app)
    const panel = await waitQuestion(app)
    // The guard only starts running once main took the page's report that it drew, so a panel past it has reported.
    await panel.waitForSelector('.q:not(.arming)')
    expect(state()?.lastNotifiedVersion).toBeUndefined()
    await panel.keyboard.press('Escape').catch(() => {})
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(mainOutput(app)).toContain('answer: closed without a choice')
    expect(await noNativeDialogs(app)).toEqual([])
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

run('Download from latest.orivonstack.eth opens that name in a new Orivon tab, never the release page, and counts the version as told', async () => {
  const { app, chrome, state } = await launched()
  try {
    await lookStarted(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Download from latest.orivonstack.eth')
    expect((await waitForTab(chrome, { address: LATEST_PAGE })).ok).toBe(true)
    expect((await tabIds(chrome)).length).toBe(2)
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect(mainOutput(app)).toContain('[self-update] answer: latest.orivonstack.eth')
    expect(mainOutput(app)).not.toContain('answer: the release page')
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

run('shows an Update Orivon button at the top left of a new tab once a release is found, keeps it after Not now and in a new tab opened later, and a press asks the question again', async () => {
  const { app, chrome, dashboard, state } = await launchedOnNewTab()
  try {
    // Nothing found yet: the button is not drawn.
    expect(await pillHidden(dashboard)).toBe(true)

    await lookStarted(app)
    await waitQuestion(app)
    // It appears on the page that is open, with no reload, as soon as the release is found.
    await dashboard.waitForSelector('#update-pill:not([hidden])')
    const pill = dashboard.locator('#update-pill')
    expect((await pill.textContent())?.trim()).toBe('Update Orivon')
    expect(await pill.getAttribute('title')).toMatch(/^Orivon 99\.0\.0 is available\. You have \d+\.\d+\.\d+/)
    expect(await pill.getAttribute('title')).not.toContain('v99')
    expect(await pill.getAttribute('aria-label')).toContain(await pill.getAttribute('title') as string)
    const box = await pill.boundingBox()
    // At the page's top left, small: a pill, not a banner.
    expect(box?.x).toBeGreaterThanOrEqual(8)
    expect(box?.x).toBeLessThanOrEqual(24)
    expect(box?.y).toBeGreaterThanOrEqual(8)
    expect(box?.y).toBeLessThanOrEqual(24)
    expect(box?.height).toBeLessThanOrEqual(36)

    // Not now dismisses the question, counts the version as told, and leaves the button.
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect(await pillHidden(dashboard)).toBe(false)
    // The version was told, and a look that runs again asks nothing: only the button asks.
    await lookDone(app)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)

    await focusWebContents(app, dashboard.url())
    await pill.click()
    const again = await readQuestion(await waitQuestion(app))
    expect(again.title).toBe('Orivon 99.0.0 is available')
    expect(again.buttons).toEqual(['Not now', 'Download from GitHub', 'Download from latest.orivonstack.eth'])
    expect(mainOutput(app)).toContain('[self-update] asking about v99.0.0 again (update button)')
    await answerQuestion(app, 'Not now')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect(await pillHidden(dashboard)).toBe(false)
    expect(state()?.lastNotifiedVersion).toBe(TAG)

    // A new tab opened afterwards shows it too.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    expect(await waitFor(() => dashboards(app).length === 2)).toBe(true)
    const second = dashboards(app).find((page) => page !== dashboard) as Page
    await second.waitForSelector('#update-pill:not([hidden])')
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('a download button on the question the update button asked opens its page in a new tab, and the update button stays', async () => {
  const { app, chrome, dashboard, state } = await launchedOnNewTab()
  try {
    await lookStarted(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => state()?.lastNotifiedVersion === TAG)).toBe(true)
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await focusWebContents(app, dashboard.url())
    await dashboard.click('#update-pill')
    await waitQuestion(app)
    await answerQuestion(app, 'Download from latest.orivonstack.eth')
    expect((await waitForTab(chrome, { address: LATEST_PAGE })).ok).toBe(true)
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    // Downloading leaves the button too: the running version is what removes it.
    expect(await pillHidden(dashboard)).toBe(false)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('hides the button on the page that is open when the update check is switched off in Settings, and draws it again when it is switched on', async () => {
  const { app, chrome, dashboard } = await launchedOnNewTab({ inUse: false })
  try {
    await lookDone(app)
    await dashboard.waitForSelector('#update-pill:not([hidden])')
    const settings = await openSettingsAbout(app, chrome)
    const check = settings.locator('#row-updates-check input[type=checkbox]')
    await check.waitFor()
    await check.click()
    expect(await waitFor(async () => await pillHidden(dashboard))).toBe(true)
    await check.click()
    expect(await waitFor(async () => !(await pillHidden(dashboard)))).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('draws no button on a new tab when the newest release is not newer than the running one', async () => {
  const { app, dashboard } = await launchedOnNewTab({ inUse: false, release: 'v0.0.1' })
  try {
    await lookDone(app)
    await delay(ABSENCE_SETTLE_MS)
    expect(await pillHidden(dashboard)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
