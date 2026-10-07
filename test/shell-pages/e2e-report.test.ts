// The bug report in the running shell: the form shows the literal report and nothing leaves until Send; a
// crashed tab's card opens it at that crash; a report can be deleted from the server; and a fatal error in the
// main process is offered for report at the next start. A loopback ingest stands in for the server.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
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
    const shown = await previewWhere(page, (report) => report['description'] === 'The  toolbar jumps when I open a tab')
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
    expect(Object.keys(body['diagnostics'] as object)).toEqual(['app', 'system', 'gpu', 'displays', 'processes', 'browser', 'recentCrashes'])
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
    expect(await waitFor(async () => await app.evaluate(({ app: electronApp }) => {
      const fs = process.getBuiltinModule('node:fs')
      try { return fs.readdirSync(`${electronApp.getPath('crashDumps')}/pending`).some((name) => name.endsWith('.dmp')) } catch { return false }
    }))).toBe(true)
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
