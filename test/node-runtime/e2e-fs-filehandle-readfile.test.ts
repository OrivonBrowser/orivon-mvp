// A file handle from fs.promises.open reads the rest of the file with readFile (from its current position to the end,
// moving the position, a Buffer or a string for an encoding) and appends with appendFile, so a program that opens its
// settings file and reads it whole loads what is there instead of falling back to defaults.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-fs-filehandle-readfile.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { FsFileHandleReadFileResults } from './fs-filehandle-readfile-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://fs-filehandle-readfile-e2e.orivon.test'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.fs-filehandle-readfile-e2e',
  name: 'fs filehandle readFile e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js'],
  capabilities: { fs: { quotaBytes: 16_777_216 } }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:node-fs-filehandle-reads-the-rest-and-appends] FileHandle#readFile reads from the handle\'s position to the end and moves it, and appendFile writes where writeFile does, so a program that reads its settings through a handle loads them', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('fs filehandle readFile', async (check) => {
      const html = '<!doctype html><html><head><title>fs filehandle fixture</title><script src="/app.js"></script></head><body><h1>fs filehandle fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./fs-filehandle-readfile-entry.ts', import.meta.url)))
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'fs filehandle fixture')
      await waitForPageGlobal(view, 'fsFileHandleReadFileE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { fsFileHandleReadFileE2e: { run: () => Promise<FsFileHandleReadFileResults> } }).fsFileHandleReadFileE2e.run(), 120_000)
      const detail = JSON.stringify(results)

      check('the page ran the cases without throwing', results.error === undefined, detail)
      check('readFile(\'utf8\') and readFile({ encoding }) give the whole text', results.text === 'first line\nsecond line\n' && results.objectForm === 'first line\nsecond line\n', detail)
      check('readFile() with no encoding gives the bytes, not a string', results.isBuffer === true && results.bufferLength === 23, detail)
      check('after a read of 5 bytes, readFile gives the rest, a second readFile gives nothing and so does a read', results.partial?.head === 'first' && results.partial.rest === ' line\nsecond line\n' && results.partial.again === '' && results.partial.readAfter === 0, detail)
      check('a file of 2.5 MiB comes back byte for byte, over several reads', results.large?.length === 2_621_440 && results.large.intact === true, detail)
      check('an empty file is an empty string', results.empty === '', detail)
      check('an encoding Node does not know is ERR_INVALID_ARG_VALUE', results.badEncoding === 'ERR_INVALID_ARG_VALUE', detail)
      check('a program that reads its settings through a handle loads them, and the file is untouched', JSON.stringify(results.settings?.loaded) === '{"theme":"dark","zoom":125}' && results.settings?.fileAfter === '{"theme":"dark","zoom":125}', detail)
      check('two appendFile calls on one handle continue one another', results.appended === 'one,two', detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 240_000)
