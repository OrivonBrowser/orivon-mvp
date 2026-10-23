// The directories above the app's files root (`/` and `/orivon`) exist as directories that list one entry, the
// next segment toward the root, and can be made again without error; everything else on them, and every path
// beside the root, stays refused. A folder-making walk from `/` therefore reaches the root and lands there.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-fs-ancestors.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { FsAncestorsResults } from './fs-ancestors-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://fs-ancestors-e2e.orivon.test'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.fs-ancestors-e2e',
  name: 'fs ancestors e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js'],
  capabilities: { fs: { quotaBytes: 65_536 } }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:node-fs-ancestors-of-the-files-root-exist] the directories above the app\'s files root exist, list one entry and refuse every write, so a walk from "/" lands in the app\'s files', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('fs ancestors', async (check) => {
      const html = '<!doctype html><html><head><title>fs ancestors fixture</title><script src="/app.js"></script></head><body><h1>fs ancestors fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./fs-ancestors-entry.ts', import.meta.url)))
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'fs ancestors fixture')
      await waitForPageGlobal(view, 'fsAncestorsE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { fsAncestorsE2e: { run: () => Promise<FsAncestorsResults> } }).fsAncestorsE2e.run(), 60_000)
      const detail = JSON.stringify(results)

      check('the page ran the case without throwing', results.error === undefined, detail)
      check('stat says "/" and "/orivon" are directories, asynchronously and synchronously', Object.values(results.stat ?? {}).length === 4 && Object.values(results.stat ?? {}).every((value) => value), detail)
      check('existsSync is true for both and false for a path beside the root', results.exists?.['/'] === true && results.exists['/orivon'] === true && results.exists['/orivon/other'] === false, detail)
      check('mkdir of an ancestor is a no-op with recursive and EEXIST without', ['/', '/orivon'].every((path) => results.mkdir?.[`recursive ${path}`] === 'no error' && results.mkdir[`plain ${path}`] === 'EEXIST' && results.mkdir[`sync plain ${path}`] === 'EEXIST'), detail)
      check('readdir lists only the next segment toward the root, never a real file', JSON.stringify(results.readdir?.['/']) === '["orivon"]' && JSON.stringify(results.readdir['/orivon']) === '["app"]' && JSON.stringify(results.readdir['sync /']) === '["orivon"]' && results.readdir['canary'] === 'a real file in the root', detail)
      check('a walk from "/" makes the missing folders and they land in the app\'s files', results.walk?.made === true && results.walk.landedInFiles === true && JSON.stringify(results.walk.attempts) === JSON.stringify(['/:dir', '/orivon:dir', '/orivon/app:dir', '/orivon/app/walk:make', '/orivon/app/walk/a:make', '/orivon/app/walk/a/b:make']), detail)
      check('every write, removal, rename and open on an ancestor, and any path beside the root, is EACCES', Object.values(results.refused ?? {}).length === 11 && Object.values(results.refused ?? {}).every((value) => value === 'EACCES'), detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 240_000)
