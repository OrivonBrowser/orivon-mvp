// The failure-evidence pipeline (qa-evidence.mjs) proven on a launched shell:
// a page that logs an error, throws, and fails a request, a main-process
// line, and a tab whose renderer is killed. The bundle written from that app
// must contain each of those, and its screenshots must be real pixels, so a
// real failure leaves a reader something to diagnose from.
//
// Not covered: an uncaught exception in the main process. Electron answers one
// with a blocking error dialog, which a headless run must never raise.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pngjs from 'pngjs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runPhase } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { bundleFor, collected, writeEvidenceBundle } from './qa-evidence.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './qa-helpers.js'
import { distinctColours } from './qa-visual.js'
import { waitFor } from './smoke-helpers.mjs'

const { PNG } = pngjs

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((_req, res) => {
    html(res, `<!doctype html><meta charset="utf-8"><title>Noisy page</title><h1>Noisy page</h1>
<script>console.error('qa-console-probe'); setTimeout(() => { throw new Error('qa-page-probe') }, 0)</script>`)
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const readJson = async (dir: string, name: string): Promise<Array<Record<string, unknown>>> => JSON.parse(await readFile(join(dir, name), 'utf8')) as Array<Record<string, unknown>>

it('writes console, page errors, failed requests, a renderer crash, the main log and real screenshots', async () => {
  const { app, chrome } = await launchShell()
  const dir = await mkdtemp(join(tmpdir(), 'orivon-qa-evidence-test-'))
  try {
    await runPhase('evidence pipeline', async (check) => {
      const url = `${server.origin}/`
      const view = await visit(app, chrome, url)
      expect(await view.evaluate(() => fetch('http://127.0.0.1:1/qa-failed-request').then(() => 'ok', () => 'failed'))).toBe('failed')
      await app.evaluate(() => { console.log('qa-main-probe-line') })
      expect(await waitFor(() => {
        const c = collected(app)
        return c !== undefined && c.console.length > 0 && c.pageErrors.length > 0 && c.failedRequests.length > 0 && mainOutput(app).includes('qa-main-probe-line')
      })).toBe(true)

      const osPid = await app.evaluate(({ webContents }, target: string) => webContents.getAllWebContents().find((wc) => wc.getURL() === target)?.getOSProcessId(), url)
      expect(osPid).toBeGreaterThan(0)
      process.kill(osPid as number, 'SIGKILL')
      expect(await waitFor(async () => await app.evaluate(() => ((globalThis as { __orivonQaEvents?: Array<{ kind: string }> }).__orivonQaEvents ?? []).some((e) => e.kind === 'render-process-gone')))).toBe(true)

      const started = Date.now()
      const bundle = await bundleFor(app, { mainLog: mainOutput(app) })
      check('a snapshot with a dead tab in the window still returns promptly', Date.now() - started < 12_000, `${String(Date.now() - started)}ms`)
      const files = await writeEvidenceBundle(dir, bundle as NonNullable<typeof bundle>)

      const consoleLog = await readJson(dir, 'console.json')
      check('console.json has the logged error', consoleLog.some((e) => e['type'] === 'error' && String(e['text']).includes('qa-console-probe')), JSON.stringify(consoleLog).slice(0, 200))
      const pageErrors = await readJson(dir, 'page-errors.json')
      check('page-errors.json has the thrown error', pageErrors.some((e) => String(e['message']).includes('qa-page-probe')), JSON.stringify(pageErrors).slice(0, 200))
      const failed = await readJson(dir, 'failed-requests.json')
      check('failed-requests.json has the refused request', failed.some((e) => String(e['url']).includes('qa-failed-request')), JSON.stringify(failed).slice(0, 200))
      const mainEvents = await readJson(dir, 'main-events.json')
      const gone = mainEvents.find((e) => e['kind'] === 'render-process-gone')
      check('main-events.json has the renderer that was killed, with its reason', gone !== undefined && typeof (gone['detail'] as { reason?: unknown }).reason === 'string', JSON.stringify(mainEvents).slice(0, 200))
      check('main.log has the line the main process printed', (await readFile(join(dir, 'main.log'), 'utf8')).includes('qa-main-probe-line'))

      const shots = files.filter((f) => f.startsWith('screenshots/') && !f.includes('composite'))
      check('at least the chrome view was screenshotted', shots.length >= 1, files.join(', '))
      for (const shot of shots) {
        const png = await readFile(join(dir, shot))
        check(`${shot} decodes and is not one flat colour`, PNG.sync.read(png).width > 0 && distinctColours(png) > 2)
      }
      const geometry = JSON.parse(await readFile(join(dir, 'window-geometry.json'), 'utf8')) as Array<{ width: number, height: number }>
      const composite = PNG.sync.read(await readFile(join(dir, 'screenshots', (await readdir(join(dir, 'screenshots'))).find((f) => f.includes('composite')) ?? 'missing.png')))
      check('the window composite is the size of the window', composite.width === geometry[0]?.width && composite.height === geometry[0]?.height, `${String(composite.width)}x${String(composite.height)} vs ${JSON.stringify(geometry[0])}`)
    })
  } finally {
    await closeElectron(app)
    await rm(dir, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS)
