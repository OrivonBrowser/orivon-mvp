// What an app stores in the browser comes back after the browser restarts. Two launches on one profile: the
// first writes into IndexedDB, localStorage, a non-extractable key and the app's own files; the second reads
// all of it back from a fresh process. Every check carries the id of the behaviour it protects, so a failure
// names what an app would lose (test/app-behaviours/catalogue.md).
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-state-restart.test.ts
import { rm } from 'node:fs/promises'
import type { ElectronApplication } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, pageCall, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

let server: AppServer
beforeAll(async () => { server = await startAppServer() })
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const MANIFEST = appManifest('state-restart', { fs: { quotaBytes: 1_048_576 } })

it('[app:indexeddb-survives-restart] [app:localstorage-survives-restart] [app:non-extractable-cryptokey-survives-restart] [app:app-files-survive-restart] [app:atomic-write-by-rename] stored data is there after a restart', async () => {
  const first = await launchShell()
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  let live: ElectronApplication | undefined = first.app
  try {
    await runPhase('app state across a restart', async (check) => {
      await grantApp(first.app, server.origin, MANIFEST, [{ capability: 'fs', patterns: [] }])
      const view = await visit(first.app, first.chrome, `${server.origin}/`)
      const written = await pageCall(server, view, async () => {
        const orivon = (window as unknown as { orivon: { fs: { writeFile: (p: string, d: Uint8Array) => Promise<void>, rename: (a: string, b: string) => Promise<void> } } }).orivon
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open('app-state', 1)
          open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
          open.onsuccess = () => { resolve(open.result) }
          open.onerror = () => { reject(open.error) }
        })
        const put = async (key: string, value: unknown): Promise<void> => await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite')
          tx.objectStore('kv').put(value, key)
          tx.oncomplete = () => { resolve() }
          tx.onerror = () => { reject(tx.error) }
        })
        await put('record', { note: 'kept in indexeddb', n: 42 })
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('sealed text')))
        await put('key', key)
        await put('sealed', { iv, cipher })
        db.close()
        localStorage.setItem('app-setting', 'dark')
        const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
        await orivon.fs.writeFile('state.txt', encode('old contents'))
        await orivon.fs.writeFile('state.tmp', encode('new contents'))
        const renamed = await orivon.fs.rename('state.tmp', 'state.txt').then(() => 'renamed', (error: unknown) => `refused: ${(error as { code?: string }).code ?? String(error)}`)
        return { extractable: key.extractable, renamed }
      })
      check('[app:non-extractable-cryptokey-survives-restart] the key was created non-extractable', written.extractable === false)
      check('[app:atomic-write-by-rename] renaming a temporary file over an existing one succeeds', written.renamed === 'renamed', written.renamed)
      await closeElectron(first.app, { keepProfile: true })
      live = undefined

      const second = await launchShell({ reuseProfile: profile })
      live = second.app
      await grantApp(second.app, server.origin, MANIFEST, [{ capability: 'fs', patterns: [] }])
      const again = await visit(second.app, second.chrome, `${server.origin}/`)
      const read = await pageCall(server, again, async () => {
        const orivon = (window as unknown as { orivon: { fs: { readFile: (p: string) => Promise<Uint8Array> } } }).orivon
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open('app-state', 1)
          open.onsuccess = () => { resolve(open.result) }
          open.onerror = () => { reject(open.error) }
        })
        const get = async (key: string): Promise<unknown> => await new Promise<unknown>((resolve, reject) => {
          if (!db.objectStoreNames.contains('kv')) { resolve(undefined); return }
          const request = db.transaction('kv', 'readonly').objectStore('kv').get(key)
          request.onsuccess = () => { resolve(request.result) }
          request.onerror = () => { reject(request.error) }
        })
        const record = await get('record')
        const key = await get('key') as CryptoKey | undefined
        const sealed = await get('sealed') as { iv: Uint8Array<ArrayBuffer>, cipher: Uint8Array<ArrayBuffer> } | undefined
        let plain = 'missing'
        if (key !== undefined && sealed !== undefined) {
          try {
            plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.cipher))
          } catch (error) {
            plain = `decrypt failed: ${(error as Error).name}`
          }
        }
        db.close()
        const file = await orivon.fs.readFile('state.txt').then((bytes) => new TextDecoder().decode(bytes), (error: unknown) => `read failed: ${(error as { code?: string }).code ?? String(error)}`)
        return { record, extractable: key?.extractable, plain, setting: localStorage.getItem('app-setting'), file }
      })
      check('[app:indexeddb-survives-restart] the record written before the restart is in IndexedDB', JSON.stringify(read.record) === JSON.stringify({ note: 'kept in indexeddb', n: 42 }), JSON.stringify(read.record))
      check('[app:localstorage-survives-restart] the localStorage value is still there', read.setting === 'dark', String(read.setting))
      check('[app:non-extractable-cryptokey-survives-restart] the stored key still decrypts what it sealed, and is still non-extractable', read.plain === 'sealed text' && read.extractable === false, `${read.plain} / extractable ${String(read.extractable)}`)
      check('[app:app-files-survive-restart] [app:atomic-write-by-rename] the app file written by temp file then rename over an existing one holds the new contents', read.file === 'new contents', read.file)
    })
  } finally {
    if (live !== undefined) await closeElectron(live)
    await rm(profile, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS * 2)
