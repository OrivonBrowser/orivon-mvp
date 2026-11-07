// readlink on the app's files answers as Node does on a disk with no links, in its callback, promise and synchronous
// forms: ENOENT for a path that is not there, EINVAL for one that is, and the same EACCES as every other call for a
// path beside the files. The async forms reject or call back and never throw, so a write helper that probes a new
// file with `realpath` and then `readlink(...).catch(() => null)` goes on to save it.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-fs-readlink.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { FsReadlinkResults, ReadlinkAnswer } from './fs-readlink-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://fs-readlink-e2e.orivon.test'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.fs-readlink-e2e',
  name: 'fs readlink e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js'],
  capabilities: { fs: { quotaBytes: 65_536 } }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type Forms = { callback: ReadlinkAnswer, promise: ReadlinkAnswer, sync: ReadlinkAnswer }

const answersOf = (forms: Forms | undefined): ReadlinkAnswer[] => (forms === undefined ? [] : [forms.callback, forms.promise, forms.sync])

const DESCRIPTION: Record<string, string> = { ENOENT: 'no such file or directory', EINVAL: 'invalid argument' }
const ERRNO: Record<string, number> = { ENOENT: -2, EINVAL: -22 }

/** Whether the callback, promise and sync forms all failed `code` for `path` as written, in Node's whole error shape. */
function everyForm (forms: Forms | undefined, code: 'ENOENT' | 'EINVAL', path: string): boolean {
  return forms !== undefined && answersOf(forms).every((answer) =>
    answer.code === code && answer.errno === ERRNO[code] && answer.syscall === 'readlink' && answer.path === path &&
    answer.message === `${code}: ${DESCRIPTION[code] ?? ''}, readlink '${path}'`)
}

it('[app:node-fs-readlink-finds-no-links] readlink says ENOENT for a path that is not there and EINVAL for one that is, in all three forms, so a write helper that probes a new file saves it', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('fs readlink', async (check) => {
      const html = '<!doctype html><html><head><title>fs readlink fixture</title><script src="/app.js"></script></head><body><h1>fs readlink fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./fs-readlink-entry.ts', import.meta.url)))
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'fs readlink fixture')
      await waitForPageGlobal(view, 'fsReadlinkE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { fsReadlinkE2e: { run: () => Promise<FsReadlinkResults> } }).fsReadlinkE2e.run(), 60_000)
      const detail = JSON.stringify(results)
      const answers = results.answers

      check('the page ran the cases without throwing', results.error === undefined, detail)
      check('a path that is not there is ENOENT in Node\'s error shape (errno -2, syscall readlink, the path as written), from the callback, the promise and the sync form', [
        ['missing', 'no-such-file.txt'], ['missingInFolder', 'folder/no-such-file.txt'], ['absoluteMissing', '/orivon/app/no-such-file.txt']
      ].every(([name, path]) => everyForm(answers?.[name as string], 'ENOENT', path as string)), detail)
      check('a file, a folder and the app\'s root are EINVAL, errno -22, in all three forms', [
        ['file', 'present.txt'], ['folder', 'folder'], ['root', '/orivon/app'], ['absoluteFile', '/orivon/app/present.txt']
      ].every(([name, path]) => everyForm(answers?.[name as string], 'EINVAL', path as string)), detail)
      check('the directories above the app\'s files exist and are EINVAL too', everyForm(answers?.aboveRoot, 'EINVAL', '/orivon') && everyForm(answers?.top, 'EINVAL', '/'), detail)
      check('a path beside the files or outside them is EACCES, as for every other call, never a target', [
        ['besideRoot', '/orivon/other'], ['outside', '/etc/hostname']
      ].every(([name, path]) => answersOf(answers?.[name as string]).length === 3 && answersOf(answers?.[name as string]).every((answer) => answer.code === 'EACCES' && answer.syscall === 'readlink' && answer.path === path && answer.returned === undefined)), detail)
      check('no form ever returned a link target', Object.values<Forms>(answers ?? {}).every((forms) => answersOf(forms).every((answer) => answer.returned === undefined)), detail)
      check('fs.promises.readlink returns a promise and does not throw when called', results.promiseReturnedNotThrown === true, detail)
      check('a write helper that resolves a new path with realpath and readlink(...).catch(() => null) saves the file', results.writer?.realpathCode === 'ENOENT' && results.writer.readlinkResult === 'null' && results.writer.written === 'the new file', detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 240_000)
