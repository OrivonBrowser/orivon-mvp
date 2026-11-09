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
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { serveApp } from '../node-runtime/pinned-app.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const ORIGIN = 'https://offline-copy-e2e.orivon.test'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.offline-copy-e2e',
  name: 'Offline copy fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'sw.js'],
  capabilities: {}
}

const WORKER = [
  "const CACHE = 'offline-copy'",
  "self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/app.js']))) })",
  "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })",
  "self.addEventListener('fetch', (event) => { event.respondWith(caches.match(event.request).then((hit) => hit ?? fetch(event.request))) })"
].join('\n')

// Reports on the body what happened, so the spec reads one string whichever step failed.
const PAGE_SCRIPT = [
  "const report = (state) => { document.body.dataset.copy = state }",
  "const within = (promise, ms, what) => Promise.race([promise, new Promise((resolve, reject) => { setTimeout(() => { reject(new Error(what + ' did not finish in ' + ms + ' ms')) }, ms) })])",
  "navigator.serviceWorker.register('/sw.js')",
  "  .then(() => within(navigator.serviceWorker.ready, 20000, 'the worker taking over'))",
  "  .then(() => caches.match('/app.js'))",
  "  .then((hit) => hit === undefined ? Promise.reject(new Error('the cache holds no /app.js')) : hit.text())",
  "  .then((text) => { report('cached ' + String(text.length) + ' bytes') }, (error) => { report('failed: ' + error.message) })"
].join('\n')

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

it('[app:service-worker-keeps-an-offline-copy] the service worker of an installed app fills Cache Storage, and the copy is served back', async () => {
  const { app, chrome } = await launchShell()
  try {
    const served = await serveApp(app, ORIGIN, MANIFEST, null, {
      '/index.html': encode('<!doctype html><title>offline copy</title><body>offline copy<script src="app.js"></script></body>'),
      '/app.js': encode(PAGE_SCRIPT),
      '/sw.js': encode(WORKER)
    })
    expect(served.registered, 'the dev-only serve hook (an e2e build)').toBe(true)

    const view = await visit(app, chrome, `${ORIGIN}/`)
    let state = 'no state'
    const settled = await waitFor(async () => {
      state = await view.evaluate(() => document.body.dataset.copy ?? 'no state')
      return state !== 'no state'
    }, 40_000)
    expect(settled, `the page reported on its worker: ${state}`).toBe(true)
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
