// An installed app's service worker fills Cache Storage, and the copy it keeps is served back. The cache lives in
// the app's own session folder under the profile, so this fails where the path of its deepest file is too long for
// the system: Windows refuses a path over 259 characters, and a test profile in the runner's default temporary
// folder is long enough to reach that limit with a 64-hex session folder name.
//
// The page is served from the loader's cache at a name nothing resolves, so the only copy of it is the pin, and the
// worker's cache is the only copy of the page a later start without the pin could use. The e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-loading/e2e-app-service-worker-cache.test.ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { partitionFor } from '../../src/broker/grants/origin-hash.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { serveApp } from '../node-runtime/pinned-app.js'
import { copyStateOf, offlineCopyFiles, offlineCopyManifest } from './offline-copy-app.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const ORIGIN = 'https://offline-copy-e2e.orivon.test'

it('[app:service-worker-keeps-an-offline-copy] the service worker of an installed app fills Cache Storage, and the copy is served back', async () => {
  const { app, chrome } = await launchShell()
  try {
    const served = await serveApp(app, ORIGIN, offlineCopyManifest('app.orivon.offline-copy-e2e'), null, offlineCopyFiles())
    expect(served.registered, 'the dev-only serve hook (an e2e build)').toBe(true)

    const view = await visit(app, chrome, `${ORIGIN}/`)
    const state = await copyStateOf(view)
    expect(state, 'the worker installed and its cache holds the page script').toMatch(/^cached [1-9]\d* bytes$/)

    const profile = profileDirOf(app)
    if (profile === undefined) throw new Error('the launcher did not report a profile directory')
    const folder = partitionFor(ORIGIN).slice('persist:'.length)
    const kept = await readdir(join(profile, 'Partitions', folder, 'Service Worker', 'CacheStorage')).catch(() => [])
    expect(kept.length, `the cache is kept under Partitions/${folder}`).toBeGreaterThan(0)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
