// An app builds a file in the page and offers it with `<a download>` on a Blob URL, as an export or "save report"
// button does. The click starts a browser download that finishes into the person's downloads folder with the name the
// app gave and the bytes it made, shows in the Downloads list, and asks nothing: no native save dialog opens.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-blob-download.test.ts
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { launchDownloads, openInternalPage, removeDir, row, scratchDir, stubSystem } from '../library/downloads-fixture.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { nativeDialogsAsked, stubNativeDialogs } from '../support/question-support.js'
import { waitFor } from '../support/smoke-helpers.mjs'

/** Distinct bytes the page makes: text with a multi-byte character, so a wrong encoding shows. */
const CONTENT = `report for the app\n${'row of data, é\n'.repeat(500)}`
// An app's own pages run no inline script (its served policy), so the page loads its script as a file.
const SCRIPT = `document.getElementById('save').addEventListener('click', () => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([${JSON.stringify(CONTENT)}], { type: 'text/plain' }))
  link.download = 'app-report.txt'
  document.body.append(link)
  link.click()
  link.remove()
})
`

let server: AppServer
let folder: string

beforeAll(async () => {
  server = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>blob download</title><body><button id="save">save</button><script src="/main.js"></script>' },
    '/main.js': { type: 'text/javascript', body: SCRIPT }
  })
  folder = await scratchDir()
})
afterAll(async () => {
  await server.close()
  await removeDir(folder)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:blob-download-saves-without-dialog] a click on an <a download> that points at a Blob the app made saves the file under the app\'s name with its bytes, lists it in Downloads and opens no native dialog', async () => {
  const { app, chrome }: { app: ElectronApplication, chrome: Page } = await launchDownloads({ folder })
  try {
    await stubSystem(app)
    await stubNativeDialogs(app)
    await grantApp(app, server.origin, appManifest('blob-download', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
    const view = await visit(app, chrome, `${server.origin}/`)
    await view.click('#save')

    const saved = join(folder, 'app-report.txt')
    const size = Buffer.byteLength(CONTENT)
    expect(await waitFor(async () => { try { return (await stat(saved)).size === size } catch { return false } }), 'the file reached the downloads folder whole').toBe(true)
    expect((await readFile(saved, 'utf8')) === CONTENT, 'with the bytes the page made').toBe(true)

    const downloads = await openInternalPage(app, chrome, 'downloads')
    await downloads.waitForSelector('.download.is-completed')
    expect(await row(downloads, 'app-report.txt').locator('.dl-name-link').textContent()).toBe('app-report.txt')
    expect(await nativeDialogsAsked(app), 'no save dialog, no message box').toEqual([])
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
