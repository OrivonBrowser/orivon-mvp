// An app the person allowed before it ran in the session websites run in kept its logins, local storage and databases in a
// partition of its own. Two launches on one profile: the first allows the app and puts that state in the partition, as the
// earlier version left it; the second opens the app, which now runs in the shared session, and its first page finds every
// cookie, item and database there. The record in the profile says the origin was carried, and the partition keeps its data.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-loading/e2e-app-storage-carry.test.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication } from 'playwright'
import { partitionFor } from '../../src/broker/grants/origin-hash.js'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from '../web3/first-visit-support.js'
import { pageAt, pinPath, savedGrants, withDeclaredTree } from '../web3/first-visit-support.js'

type App = ElectronApplication

/** A worker that answers every navigation with a page that deletes what the app stored: what an app's own code could do to the data being carried. */
const WORKER = `self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(new Response('<!doctype html><title>worker page</title><script>indexedDB.deleteDatabase("carry-db"); localStorage.clear()</script>', { headers: { 'content-type': 'text/html' } }))
})`

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  'sw.js': WORKER,
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'sw.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

/** What the earlier version left in the app's partition: a script-set cookie, local storage, a database of three stores. */
const SEED_PAGE = `(async () => {
  localStorage.setItem('carry-local', 'local-value')
  localStorage.setItem('carry-local-large', 'x'.repeat(200000))
  document.cookie = 'carry-js=js-value; path=/; max-age=86400; secure'
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('carry-db', 4)
    request.onupgradeneeded = () => {
      const created = request.result
      const notes = created.createObjectStore('notes', { keyPath: 'id' })
      notes.createIndex('by-title', 'title', { unique: true })
      notes.createIndex('by-tag', 'tags', { multiEntry: true })
      created.createObjectStore('files', { autoIncrement: true })
      created.createObjectStore('bulk', { keyPath: 'n' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'files', 'bulk'], 'readwrite')
    tx.objectStore('notes').put({ id: 1, title: 'First', tags: ['x', 'y'], when: new Date(1700000000000) })
    tx.objectStore('notes').put({ id: 2, title: 'Second', tags: ['y'], when: new Date(1700000001000) })
    const big = new Uint8Array(1500000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251
    tx.objectStore('files').put({ name: 'a.txt', blob: new Blob(['blob-bytes'], { type: 'text/plain' }), bytes: new Uint8Array([1, 2, 3]), at: new Map([['k', new Set([1, 2])]]) })
    tx.objectStore('files').put({ name: 'big.bin', blob: new Blob([big], { type: 'application/octet-stream' }) })
    for (let n = 0; n < 450; n++) tx.objectStore('bulk').put({ n, text: 'row ' + n + ' ' + 'y'.repeat(1500) })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  const registration = await navigator.serviceWorker.register('/sw.js')
  const worker = registration.installing || registration.waiting || registration.active
  if (worker.state !== 'activated') await new Promise((resolve) => { worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve() }) })
  return 'seeded:' + worker.state
})()`

/** What the app's first page finds in its own storage, as JSON. */
const READ_PAGE = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('carry-db')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const all = (store, index, query) => new Promise((resolve, reject) => {
    const source = index === undefined ? db.transaction(store).objectStore(store) : db.transaction(store).objectStore(store).index(index)
    const request = query === undefined ? source.getAll() : source.getAll(query)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const keys = (store) => new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const shape = db.transaction('notes').objectStore('notes')
  const titleUnique = shape.index('by-title').unique
  const tagMultiEntry = shape.index('by-tag').multiEntry
  const files = await all('files')
  const big = files.find((file) => file.name === 'big.bin')
  const bigBytes = new Uint8Array(await big.blob.arrayBuffer())
  let bigCorrupt = 0
  for (let i = 0; i < bigBytes.length; i++) if (bigBytes[i] !== (i * 31) % 251) bigCorrupt++
  const small = files.find((file) => file.name === 'a.txt')
  return JSON.stringify({
    cookie: document.cookie,
    local: localStorage.getItem('carry-local'),
    localLarge: (localStorage.getItem('carry-local-large') || '').length,
    version: db.version,
    stores: Array.from(db.objectStoreNames).sort(),
    noteTitles: (await all('notes')).map((note) => note.title + '@' + note.when.getTime()),
    byTag: (await all('notes', 'by-tag', 'y')).length,
    titleUnique,
    tagMultiEntry,
    fileKeys: await keys('files'),
    blobText: await small.blob.text(),
    blobType: small.blob.type,
    smallBytes: Array.from(small.bytes),
    map: Array.from(small.at.get('k')),
    bigSize: bigBytes.length,
    bigType: big.blob.type,
    bigCorrupt,
    bulk: (await all('bulk')).length,
    bulkLast: (await all('bulk')).at(-1).text.length
  })
})()`

/** Puts the earlier version's state in the partition `partition` of the app at `origin`, from a hidden page of that partition. */
async function seedPartition (app: App, partition: string, origin: string): Promise<string> {
  return await app.evaluate(async ({ session, WebContentsView }, { partition: name, origin: at, script }) => {
    const old = session.fromPartition(name)
    const view = new WebContentsView({ webPreferences: { session: old, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
    const contents = view.webContents
    try {
      contents.setAudioMuted(true)
      await contents.loadURL(`${at}/index.html`)
      const seeded = await contents.executeJavaScript(script) as string
      await old.cookies.set({ url: `${at}/`, name: 'carry-http-only', value: 'http-only-value', secure: true, httpOnly: true, sameSite: 'strict', expirationDate: Math.floor(Date.now() / 1000) + 86_400 })
      await old.cookies.flushStore()
      await old.flushStorageData()
      return seeded
    } finally {
      contents.close()
      // The view is held to the end: Electron destroys a view's page once the view itself is collected.
      void view
    }
  }, { partition, origin, script: SEED_PAGE })
}

/** Runs `script` in the newest page at `url` and returns what it answers, or null when no page is there. */
async function askPage (app: App, url: string, script: string): Promise<string | null> {
  return await app.evaluate(async ({ webContents }, { address, code }) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    return await Promise.race([
      (newest.executeJavaScript(code) as Promise<string>).catch((error: unknown) => `ERR:${String(error)}`),
      new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 20_000))
    ])
  }, { address: url, code: script }).catch(() => null)
}

/** Which session the newest page at `url` runs in. */
async function sessionOf (app: App, url: string): Promise<'shared' | 'partition' | null> {
  return await app.evaluate(({ session, webContents }, address) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    return newest.session === session.defaultSession ? 'shared' as const : 'partition' as const
  }, url).catch(() => null)
}

async function waitListening (app: App): Promise<boolean> {
  return await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
}

const TEST_TIMEOUT_MS = (ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS) * 2 + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:storage-follows-an-app-into-the-website-session] carries an allowed app\'s cookies, local storage and databases from its old partition into the session websites run in, before its first page loads, and keeps the old data', async () => {
  await runPhase('app storage carried into the website session', async (check) => {
    const gateway = await startFixtureGateway({ allowed: await withDeclaredTree(files('Carried app', 'carried.app')) })
    const root = gateway.roots['allowed']!
    const origin = `https://${root}.ipfs.orivon`
    const partition = partitionFor(origin)
    const env = { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '500' }
    let first: App | undefined
    let second: App | undefined
    let profile = ''
    try {
      first = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true, env })
      const one = first
      await stubNativeDialogs(one)
      check('the verifier host listens', await waitListening(one))
      await waitFor(() => one.windows().length >= 2)
      const chrome = findChrome(one)
      await waitForAddressBarStable(chrome)
      const userData = await one.evaluate(({ app }) => app.getPath('userData'))
      profile = profileDirOf(one) ?? userData

      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(one, 60_000)
      await answerQuestion(one, 'Grant all')
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(one, `${origin}/`); return facts?.ran === 'ran' && facts.hasProcess }, 60_000)
      check(`the app is allowed and runs (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess && savedGrants(userData, origin).includes('fs'))
      check('it runs in the session websites run in', await sessionOf(one, `${origin}/`) === 'shared')
      check('the app is pinned', await waitFor(() => existsSync(pinPath(userData, origin)), 60_000))
      check('a partition with nothing in it leaves no record', !existsSync(join(userData, 'carried-app-storage.json')) || !(JSON.parse(readFileSync(join(userData, 'carried-app-storage.json'), 'utf8')) as { origins: Record<string, unknown> }).origins[origin])

      check('the earlier version\'s state and a worker that answers every navigation are put in the partition', await seedPartition(one, partition, origin) === 'seeded:activated')
      await closeElectronApp(one, APP_CLOSE_RACE_MS, { keepProfile: true })
      first = undefined

      second = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], sandbox: true, env, reuseProfile: profile })
      const two = second
      await stubNativeDialogs(two)
      check('the verifier host listens again', await waitListening(two))
      await waitFor(() => two.windows().length >= 2)
      const chromeTwo = findChrome(two)
      await waitForAddressBarStable(chromeTwo)
      await clickAddressBarRetrying(chromeTwo, `ipfs://${root}`)
      let again = null as PageFacts | null
      await waitFor(async () => { again = await pageAt(two, `${origin}/`); return again?.ran === 'ran' && again.hasProcess }, 90_000)
      check(`the app opens from its kept copy (${JSON.stringify(again)})`, again?.ran === 'ran' && again.hasProcess)
      check('in the session websites run in', await sessionOf(two, `${origin}/`) === 'shared')

      const read = await askPage(two, `${origin}/`, READ_PAGE)
      const found = read === null || read.startsWith('ERR:') ? null : JSON.parse(read) as Record<string, unknown>
      check(`the first page reads the database back (${read === null ? 'no answer' : read.slice(0, 600)})`, found !== null)
      check('the script-set cookie arrived', typeof found?.['cookie'] === 'string' && (found['cookie'] as string).includes('carry-js=js-value'))
      check('local storage arrived, the large item whole', found?.['local'] === 'local-value' && found['localLarge'] === 200000)
      check('the database arrived at its version with its stores', found?.['version'] === 4 && JSON.stringify(found['stores']) === JSON.stringify(['bulk', 'files', 'notes']))
      check('the notes arrived with their dates and both indexes', JSON.stringify(found?.['noteTitles']) === JSON.stringify(['First@1700000000000', 'Second@1700000001000']) && found?.['byTag'] === 2 && found['titleUnique'] === true && found['tagMultiEntry'] === true)
      check('an auto-increment store kept its keys', JSON.stringify(found?.['fileKeys']) === JSON.stringify([1, 2]))
      check('a Blob, its type, a typed array, a map and a set arrived', found?.['blobText'] === 'blob-bytes' && found['blobType'] === 'text/plain' && JSON.stringify(found['smallBytes']) === JSON.stringify([1, 2, 3]) && JSON.stringify(found['map']) === JSON.stringify([1, 2]))
      check('a Blob of a million and a half bytes arrived byte for byte', found?.['bigSize'] === 1_500_000 && found['bigType'] === 'application/octet-stream' && found['bigCorrupt'] === 0)
      check('a store of more records than one batch arrived whole', found?.['bulk'] === 450 && found['bulkLast'] === 'row 449 '.length + 1500)

      const hidden = await two.evaluate(async ({ session }, { at }) => (await session.defaultSession.cookies.get({ url: `${at}/`, name: 'carry-http-only' })).map((cookie) => ({ value: cookie.value, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, hostOnly: cookie.hostOnly })), { at: origin })
      check(`the http-only cookie arrived with its attributes (${JSON.stringify(hidden)})`, hidden.length === 1 && hidden[0]?.value === 'http-only-value' && hidden[0].httpOnly === true && hidden[0].secure === true && hidden[0].sameSite === 'strict' && hidden[0].hostOnly === true)

      const kept = await two.evaluate(async ({ session }, { name, at }) => ({
        cookies: (await session.fromPartition(name).cookies.get({ url: `${at}/` })).map((cookie) => cookie.name).sort(),
        stillThere: (await session.fromPartition(name).cookies.get({ name: 'carry-http-only' })).length
      }), { name: partition, at: origin })
      check(`the partition keeps its data (${JSON.stringify(kept)})`, kept.stillThere === 1 && kept.cookies.includes('carry-js'))

      const record = JSON.parse(readFileSync(join(profile, 'carried-app-storage.json'), 'utf8')) as { origins: Record<string, { status: string, attempts: number, report: { cookies: { carried: number }, localStorage: { carried: number }, databases: { carried: number }, records: { carried: number, failed: number }, problems: string[] } }> }
      const row = record.origins[origin]
      check(`the profile records the origin as carried (${JSON.stringify(row)})`, row?.status === 'carried' && row.attempts === 1 && row.report.cookies.carried === 2 && row.report.localStorage.carried === 2 && row.report.databases.carried === 1 && row.report.records.carried === 454 && row.report.records.failed === 0 && row.report.problems.length === 0)
    } finally {
      if (first !== undefined) await closeElectronApp(first)
      if (second !== undefined) await closeElectronApp(second)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
