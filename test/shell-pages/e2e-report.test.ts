// The bug report in the running shell: the form shows the literal report and nothing leaves until Send; a
// crashed tab's card opens it at that crash; a report can be deleted from the server; and a fatal error in the
// main process is offered for report at the next start. A loopback ingest stands in for the server.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { listDumps } from '../../src/main/diagnostics/dump-files.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { startIngest } from '../support/telemetry-ingest.js'
import type { Ingest } from '../support/telemetry-ingest.js'
import { delay, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']
const TOP_LEVEL = ['schema', 'reportId', 'description', 'contact', 'version', 'crash', 'diagnostics', 'log', 'page', 'dump']

let server: FixtureServer
let ingest: Ingest

beforeAll(async () => {
  server = await startServer((request, response) => { html(response, `<!doctype html><title>crash fixture</title><body><h1>${request.url ?? '/'}</h1></body>`) })
  ingest = await startIngest()
})

afterAll(async () => {
  await server.close()
  await ingest.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const launch = async (options: Parameters<typeof launchShell>[0] = {}): ReturnType<typeof launchShell> => await launchShell({ ...options, env: { ORIVON_TELEMETRY_URL: ingest.url, ...(options.env ?? {}) } })

async function runCommand (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

async function pageAt (app: App, prefix: string): Promise<Page> {
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(prefix) && !w.isClosed())), `${prefix} did not open`).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith(prefix) && !w.isClosed()) as Page
  await page.waitForSelector('#report-what')
  return page
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.evaluate(() => { window.scrollTo(0, 0) })
    await delay(400)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
}

const previewOf = async (page: Page): Promise<Record<string, unknown>> => JSON.parse(await page.locator('#report-preview').textContent() ?? '{}') as Record<string, unknown>

/** Waits until the preview, which main rebuilds shortly after each change, satisfies `ok`. */
async function previewWhere (page: Page, ok: (report: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {}
  expect(await waitFor(async () => { last = await previewOf(page); return ok(last) }), JSON.stringify(last).slice(0, 400)).toBe(true)
  return last
}

/** What each folder under the crash folder holds, for a failure message. */
const listFolders = (dir: string): Record<string, string[] | string> => {
  const out: Record<string, string[] | string> = {}
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { try { out[entry.name] = readdirSync(join(dir, entry.name)) } catch (error) { out[entry.name] = String(error) } }
    }
  } catch (error) { out['.'] = String(error) }
  return out
}
const reportRequests = (): Ingest['requests'] => ingest.requests.filter((request) => request.path.endsWith('/report'))

it('shows the literal report, sends it only on Send, and deletes it from the server on request', async () => {
  const { app, chrome } = await launch()
  try {
    await runCommand(chrome, 'report.open')
    const page = await pageAt(app, 'orivon://report')
    expect(await page.locator('h1').textContent()).toBe('Report a problem')

    // Nothing is sent by opening the page, and it cannot be sent without a description.
    expect(await page.locator('#report-send').isDisabled()).toBe(true)
    expect(await page.locator('#report-disclosure').textContent()).toContain('AI coding assistant')
    expect(reportRequests()).toEqual([])
    await shoot(page, 'report-empty')

    await page.fill('#report-what', 'The  toolbar jumps when I open a tab')
    await page.fill('#report-contact', 'someone@example.org')
    // Each field rebuilds the preview on its own, so wait for both: a preview of the description alone has no contact yet.
    const shown = await previewWhere(page, (report) => report['description'] === 'The  toolbar jumps when I open a tab' && report['contact'] === 'someone@example.org')
    expect(Object.keys(shown)).toEqual(TOP_LEVEL)
    expect(shown).toMatchObject({ schema: 1, contact: 'someone@example.org', crash: null, page: null, dump: null })
    expect(shown['diagnostics']).not.toBeNull()
    expect(Array.isArray(shown['log'])).toBe(true)
    expect(await page.locator('#report-send').isDisabled()).toBe(false)

    // The boxes decide what is in the report.
    await page.uncheck('#report-diagnostics')
    await page.uncheck('#report-log')
    await previewWhere(page, (report) => report['diagnostics'] === null && report['log'] === null)
    await page.check('#report-diagnostics')
    await page.check('#report-log')
    const full = await previewWhere(page, (report) => report['diagnostics'] !== null && report['log'] !== null)
    await page.locator('#report-whole summary').click()
    await shoot(page, 'report-filled')

    await page.click('#report-send')
    await page.waitForSelector('#report-id')
    const reportId = await page.locator('#report-id').textContent() ?? ''
    expect(reportId).toMatch(/^[0-9a-f]{32}$/)
    expect(await page.locator('#report-sent-banner').textContent()).toContain('Sent. Report ID')

    expect(reportRequests()).toHaveLength(1)
    const body = reportRequests()[0]?.body as Record<string, unknown>
    expect(Object.keys(body)).toEqual(TOP_LEVEL)
    expect(body).toMatchObject({ schema: 1, reportId, description: 'The  toolbar jumps when I open a tab', contact: 'someone@example.org', crash: null, page: null, dump: null })
    expect(body['version']).toMatch(/^[0-9A-Za-z.+-]{1,32}$/)
    // The literal preview is what was sent: the diagnostics and the log of the moment the page asked.
    expect(body['diagnostics']).toEqual(full['diagnostics'])
    expect(Object.keys(body['diagnostics'] as object)).toEqual(['app', 'system', 'gpu', 'displays', 'processes', 'browser', 'startup', 'recentCrashes'])
    // The start-up record of this run: the launch's own marks, whole milliseconds, and the hooks that ran.
    const startup = (body['diagnostics'] as { startup: { complete: boolean, marks: Record<string, number | null>, hooks: Array<{ name: string, phase: string, ms: number }> } }).startup
    for (const name of ['entry', 'launched', 'bootStart', 'appReady', 'afterReadyDone', 'afterWindowDone', 'storesLoaded', 'firstWindowCreated']) expect(Number.isInteger(startup.marks[name])).toBe(true)
    expect(startup.hooks.length).toBeGreaterThan(0)
    expect(startup.hooks.every((hook) => Number.isInteger(hook.ms) && ['beforeReady', 'afterReady', 'afterWindow'].includes(hook.phase))).toBe(true)
    // Main states WebGPU's state and the reason in one word each; on a virtual display it is off.
    const webgpu = (body['diagnostics'] as { gpu: { webgpu: Record<string, string> } }).gpu.webgpu
    expect(Object.keys(webgpu)).toEqual(['state', 'reason'])
    if (process.platform === 'linux') expect(webgpu).toEqual({ state: 'unavailable', reason: expect.stringMatching(/^(software-only|x11|xwayland)$/) })
    const home = await app.evaluate(({ app: electronApp }) => electronApp.getPath('home'))
    expect(JSON.stringify(body)).not.toContain(home)
    await shoot(page, 'report-sent')

    // The report is listed, and deleting it asks the server.
    const row = page.locator(`.sent-row[data-report-id="${reportId}"]`)
    await row.waitFor()
    await row.locator('.btn.danger').click()
    expect(await row.locator('.btn.danger').textContent()).toBe('Click again to delete')
    await row.locator('.btn.danger').click()
    await page.waitForSelector('#report-sent-empty')
    const erase = ingest.requests.find((request) => request.path.endsWith('/report-erase'))
    expect(erase?.body).toEqual({ schema: 1, reportId })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('keeps the form and says why when the server refuses, and sends the same report ID again on a retry', async () => {
  const { app, chrome } = await launch()
  try {
    ingest.requests.length = 0
    await runCommand(chrome, 'report.open')
    const page = await pageAt(app, 'orivon://report')
    await page.fill('#report-what', 'Retry me')
    await previewWhere(page, (report) => report['description'] === 'Retry me')
    ingest.respondWith(503)
    await page.click('#report-send')
    await page.waitForSelector('#report-failed')
    expect(await page.locator('#report-failed').textContent()).toContain('cannot take more reports')
    expect(await page.inputValue('#report-what')).toBe('Retry me')
    ingest.respondWith(204)
    await page.click('#report-send')
    await page.waitForSelector('#report-id')
    const ids = reportRequests().map((request) => request.body['reportId'])
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  } finally {
    ingest.respondWith(204)
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('offers Report on a crashed tab\'s card, which opens the form at that crash', async () => {
  const { app, chrome } = await launch()
  try {
    ingest.requests.length = 0
    const address = `${server.origin}/`
    await visit(app, chrome, address)
    await app.evaluate(({ webContents }, target) => {
      const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)
      if (wc === undefined) throw new Error(`no webContents at ${target}`)
      setTimeout(() => { wc.forcefullyCrashRenderer() }, 0)
    }, address)
    expect(await waitFor(async () => await popoverShown(app, 'overlay=sad-tab'))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=sad-tab') && !w.isClosed()))).toBe(true)
    const card = app.windows().filter((w) => w.url().includes('overlay=sad-tab') && !w.isClosed()).at(-1) as Page
    await card.waitForSelector('.sad .btn')
    expect(await card.locator('.sad .btn').allTextContents()).toEqual(['Report', 'Close tab', 'Reload'])
    // Crashpad writes the dump a moment after the process dies; the form lists it only if it is there when it opens.
    // The folders are the ones the product lists: Windows writes to `reports`, the others to `pending`.
    const crashDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('crashDumps'))
    const dumpFound = await waitFor(() => listDumps(crashDir).length > 0)
    expect(dumpFound, `no .dmp under ${crashDir}: ${JSON.stringify(listFolders(crashDir))}`).toBe(true)
    await card.getByRole('button', { name: 'Report', exact: true }).click()

    const page = await pageAt(app, 'orivon://report/crash/')
    const chosen = await page.inputValue('#report-crash')
    expect(chosen).toMatch(/^[0-9a-f]{16}$/)
    const crashShown = await previewWhere(page, (report) => report['crash'] !== null)
    expect(crashShown['crash']).toMatchObject({ kind: 'renderer', process: 'tab' })
    // The page address is offered, and off.
    expect(await page.locator('#report-page').isChecked()).toBe(false)
    expect(crashShown['page']).toBeNull()
    await page.check('#report-page')
    const withPage = await previewWhere(page, (report) => report['page'] === address)
    expect(withPage['page']).toBe(address)
    // The dump is offered with its size and stays off until ticked; ticked, it goes as bytes and the preview shows its size.
    expect(await page.locator('#report-dump').isChecked()).toBe(false)
    expect(await page.locator('#report-dump').locator('xpath=ancestor::label').textContent()).toMatch(/crash dump \(\d+ KB\)/)
    await page.check('#report-dump')
    const withDump = await previewWhere(page, (report) => report['dump'] !== null)
    expect((withDump['dump'] as { base64: string }).base64).toMatch(/^<\d+ bytes of binary>$/)
    await page.fill('#report-what', 'The page died')
    await previewWhere(page, (report) => report['description'] === 'The page died')
    await shoot(page, 'report-crash')
    await page.click('#report-send')
    await page.waitForSelector('#report-id')
    const body = reportRequests()[0]?.body as { crash: Record<string, unknown>, page: string, dump: { base64: string, bytes: number } }
    const bytes = Buffer.from(body.dump.base64, 'base64')
    expect(bytes.length).toBe(body.dump.bytes)
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('MDMP')
    expect(body.crash['kind']).toBe('renderer')
    expect(body.page).toBe(address)
    expect(Object.keys(body.crash)).toEqual(['kind', 'at', 'process', 'reason', 'exitCode', 'message', 'stack'])
    expect(body.crash['at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    // Crash dumps are written beside the profile, not in a folder of their own.
    const where = await app.evaluate(({ app: electronApp }) => ({ dumps: electronApp.getPath('crashDumps'), data: electronApp.getPath('userData') }))
    expect(where.dumps.startsWith(where.data)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('offers a report of the last run\'s fatal error at the next start, with the stack in it', async () => {
  const first = await launch()
  let profile: string | undefined
  try {
    await runCommand(first.chrome, 'report.open')
    const page = await pageAt(first.app, 'orivon://report')
    profile = await first.app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const exited = new Promise<number | null>((resolve) => { first.app.process().once('exit', (code) => { resolve(code) }) })
    await page.locator('#report-tests summary').click()
    await page.click('#report-test-main-error')
    expect(await exited).toBe(1)
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }

  const second = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], reuseProfile: profile, env: { ORIVON_TELEMETRY_URL: ingest.url } })
  try {
    findChrome(second)
    expect(await waitFor(async () => await popoverShown(second, 'overlay=restore'))).toBe(true)
    expect(await waitFor(() => second.windows().some((w) => w.url().includes('overlay=restore') && !w.isClosed()))).toBe(true)
    const bar = second.windows().find((w) => w.url().includes('overlay=restore') && !w.isClosed()) as Page
    await bar.waitForSelector('.restorebar')
    await shoot(bar, 'report-crash-bar')
    await bar.getByRole('button', { name: 'Report the problem' }).click()
    const page = await pageAt(second, 'orivon://report/crash/')
    const shown = await previewWhere(page, (report) => report['crash'] !== null)
    expect(shown['crash']).toMatchObject({ kind: 'main-error', process: 'main', reason: 'uncaught exception' })
    expect(String((shown['crash'] as Record<string, unknown>)['message'])).toContain('thrown on purpose')
    expect(String((shown['crash'] as Record<string, unknown>)['stack'])).toContain('thrown on purpose')
    expect(JSON.stringify(shown['log'])).toContain('uncaught exception')
  } finally {
    await closeElectron(second)
  }
}, QA_TEST_TIMEOUT_MS * 2)

/** Holds the main process's event loop for `ms`, the way a long synchronous job does. */
const stallMain = async (app: App, ms: number): Promise<void> => {
  await app.evaluate((_electron, hold) => { const end = Date.now() + hold; while (Date.now() < end) { /* busy */ } }, ms)
}

it('counts the main process\'s stalls, and words a run the window system ended as the desktop\'s doing at the next start', async () => {
  const first = await launch()
  let profile: string | undefined
  try {
    profile = await first.app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    await stallMain(first.app, 2400)
    await delay(1200)
    await runCommand(first.chrome, 'report.open')
    const page = await pageAt(first.app, 'orivon://report')
    const stalls = (report: Record<string, unknown>): { over1s: number, over5s: number, longestMs: number } | undefined => (report['diagnostics'] as { browser?: { mainStalls?: { over1s: number, over5s: number, longestMs: number } } } | null)?.browser?.mainStalls
    const counted = await previewWhere(page, (report) => (stalls(report)?.over1s ?? 0) >= 1)
    expect(Object.keys(stalls(counted) ?? {})).toEqual(['over1s', 'over5s', 'longestMs'])
    expect(stalls(counted)?.longestMs).toBeGreaterThanOrEqual(1500)
    expect(stalls(counted)?.over5s).toBeLessThanOrEqual(stalls(counted)?.over1s ?? 0)
    // What the shell does when a window ends with no close: the call is made in the main process, then the process goes without a quit.
    await first.app.evaluate(() => { (globalThis as unknown as { __orivonDevWindowSystemEnd: () => void }).__orivonDevWindowSystemEnd() })
    first.app.process().kill('SIGKILL')
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }

  const second = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], reuseProfile: profile, env: { ORIVON_TELEMETRY_URL: ingest.url } })
  try {
    findChrome(second)
    expect(await waitFor(async () => await popoverShown(second, 'overlay=restore'))).toBe(true)
    expect(await waitFor(() => second.windows().some((w) => w.url().includes('overlay=restore') && !w.isClosed()))).toBe(true)
    const bar = second.windows().find((w) => w.url().includes('overlay=restore') && !w.isClosed()) as Page
    await bar.waitForSelector('.restorebar')
    await bar.waitForFunction(() => document.querySelector('.restore-text')?.textContent !== 'Orivon didn\'t shut down correctly.')
    expect(await bar.textContent('.restore-text')).toBe('The desktop ended Orivon\'s window.')
    expect(await bar.getAttribute('.restore-text', 'title')).toBe('The desktop\'s display server ended its connection to Orivon\'s window, so Orivon could not go on.')
    await shoot(bar, 'report-display-lost-bar')
    await bar.getByRole('button', { name: 'Report the problem' }).click()
    const page = await pageAt(second, 'orivon://report/crash/')
    const shown = await previewWhere(page, (report) => report['crash'] !== null)
    // The kind is one the report server takes; the reason and the words say what happened.
    expect(shown['crash']).toMatchObject({ kind: 'unclean-exit', process: 'main', reason: 'display-lost' })
    const message = String((shown['crash'] as Record<string, unknown>)['message'])
    expect(message).toContain('display server ended its connection to Orivon\'s window')
    expect(message).toMatch(/Before that the main process had stalled (once|\d+ times) for 1 s or more, the longest for \d+\.\d s\./)
    // The log is the dead run's own: the stall and the end are in it.
    expect(JSON.stringify(shown['log'])).toContain('The main process did not answer for about')
    expect(JSON.stringify(shown['log'])).toContain('The window was ended without a close')
    expect(await page.locator('#report-crash option:checked').textContent()).toMatch(/^The desktop's display server ended Orivon's window: /)
  } finally {
    await closeElectron(second)
  }
}, QA_TEST_TIMEOUT_MS * 2)
