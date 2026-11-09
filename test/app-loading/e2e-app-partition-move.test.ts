// What an installed app stored comes back after a start that finds its session folder under the name an earlier
// version gave it. Two launches on one profile: the first stores data in the app's own session (localStorage,
// IndexedDB, Cache Storage and a service worker); the folder is then renamed to the old 64-digit name, as a
// profile that earlier version made holds it; the second launch must move it to the short name before any session
// opens, and the app must read everything back from it.
//
// The page is served from the loader's cache, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-loading/e2e-app-partition-move.test.ts
import { readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { originHash, partitionFor } from '../../src/broker/grants/origin-hash.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { serveApp } from '../node-runtime/pinned-app.js'
import { copyStateOf, offlineCopyFiles, offlineCopyManifest } from './offline-copy-app.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const ORIGIN = 'https://partition-move-e2e.orivon.test'

/** A folder a process has only just let go of can be refused for a moment on Windows. */
async function renameWhenFree (from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

it('[app:app-storage-survives-an-update] an installed app finds its stored data after its session folder is moved from the long name to the short one', async () => {
  const first = await launchShell()
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  const short = partitionFor(ORIGIN).slice('persist:'.length)
  const long = `app-${originHash(ORIGIN)}`
  const partitions = join(profile, 'Partitions')
  let live: ElectronApplication | undefined = first.app
  try {
    const served = await serveApp(first.app, ORIGIN, offlineCopyManifest('app.orivon.partition-move-e2e'), null, offlineCopyFiles())
    expect(served.registered, 'the dev-only serve hook (an e2e build)').toBe(true)
    const view = await visit(first.app, first.chrome, `${ORIGIN}/`)
    expect(await copyStateOf(view), 'the worker installed in the first launch').toMatch(/^cached [1-9]\d* bytes$/)
    await view.evaluate(async () => {
      localStorage.setItem('kept', 'in local storage')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('kept', 1)
        open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
        open.onsuccess = () => { resolve(open.result) }
        open.onerror = () => { reject(open.error) }
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put('in indexeddb', 'note')
        tx.oncomplete = () => { resolve() }
        tx.onerror = () => { reject(tx.error) }
      })
      db.close()
      await (await caches.open('marker')).put('/marker', new Response('in cache storage'))
    })
    expect(await readdir(partitions), 'the app\'s session is the short name on disk').toContain(short)

    await closeElectron(first.app, { keepProfile: true })
    live = undefined
    await renameWhenFree(join(partitions, short), join(partitions, long))
    expect(await readdir(partitions), 'the profile now holds the folder as an earlier version named it').toContain(long)

    const second = await launchShell({ reuseProfile: profile })
    live = second.app
    const again = await visit(second.app, second.chrome, `${ORIGIN}/`)
    const read = await again.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('kept', 1)
        open.onsuccess = () => { resolve(open.result) }
        open.onerror = () => { reject(open.error) }
      })
      const note = await new Promise<unknown>((resolve, reject) => {
        if (!db.objectStoreNames.contains('kv')) { resolve('no store'); return }
        const request = db.transaction('kv', 'readonly').objectStore('kv').get('note')
        request.onsuccess = () => { resolve(request.result) }
        request.onerror = () => { reject(request.error) }
      })
      db.close()
      const marker = await caches.match('/marker')
      return { local: localStorage.getItem('kept'), note, cache: marker === undefined ? 'missing' : await marker.text() }
    })
    expect(read, 'localStorage, IndexedDB and Cache Storage are what the first launch stored').toEqual({ local: 'in local storage', note: 'in indexeddb', cache: 'in cache storage' })

    const names = await readdir(partitions)
    expect(names, 'the long name is gone').not.toContain(long)
    expect(names, 'the short name holds the session').toContain(short)

    const logged = await waitFor(async () => (await readFile(join(profile, 'diagnostics', 'logs', 'current.log'), 'utf8').catch(() => '')).includes(`[partitions] moved app-${originHash(ORIGIN).slice(0, 8)}`))
    expect(logged, 'the log, which orivon://report shows, says the folder was moved').toBe(true)
  } finally {
    if (live !== undefined) await closeElectron(live)
    await rm(profile, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS * 2)
