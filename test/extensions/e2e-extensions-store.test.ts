// The Chrome Web Store install path end to end, fully offline: no real
// chromewebstore.google.com origin exists to test against (a local server
// cannot serve that real hostname), so this drives the Orivon half directly
// -- `globalThis.__orivonDevExtensionsStore.installFromStore(id)`, the
// dev-only hook store-test-hook.ts installs in an e2e build
// (install-runner.ts's own doc on `installFromStore` says why this is the
// seam and not a `chrome.webstorePrivate` page). Two env vars, read only by
// store-download-seam.ts's compiled-in-test-builds-only functions, point
// the download URL and the "publisher" key hash this suite controls at a
// local fixture server instead of the real store.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-store.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { answeringWith, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import { closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { parseRegistry } from '../../src/main/extensions/registry.js'
import { buildManifestCrx as buildCrx, makeRsaKeyPair } from './store-crx-support.js'

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

it('installs a publisher-signed fixture from the store, and refuses one with no publisher proof, writing nothing for it', async () => {
  const dev = makeRsaKeyPair()
  const publisher = makeRsaKeyPair()
  const publisherKeyHash = createHash('sha256').update(publisher.publicKey).digest().toString('hex')

  const validManifest = { manifest_version: 3, name: 'Orivon E2E Store Fixture', version: '1.0.0', permissions: ['storage'] }
  const valid = buildCrx(validManifest, dev, publisher)

  const noPublisherDev = makeRsaKeyPair()
  const noPublisherManifest = { manifest_version: 3, name: 'Orivon E2E Store No Publisher', version: '1.0.0' }
  const noPublisher = buildCrx(noPublisherManifest, noPublisherDev) // developer proof only

  const crxById = new Map([[valid.id, valid.bytes], [noPublisher.id, noPublisher.bytes]])

  const httpServer = createServer((req, res) => {
    if (req.url === '/' || req.url === undefined) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>extensions-store-fixture</title><body>fixture</body>')
      return
    }
    const id = req.url.replace(/^\//, '').replace(/\.crx$/, '')
    const bytes = crxById.get(id)
    if (bytes === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/x-chrome-extension' })
    res.end(bytes)
  })
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve) })
  server = httpServer
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  const origin = `http://127.0.0.1:${String(address.port)}`

  await runPhase('chrome web store install', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_STORE_BASE_URL: origin,
          ORIVON_TEST_STORE_PUBLISHER_KEY_HASH: publisherKeyHash
        },
        sandbox: true
      })

      // installFromStore(id) (no approvedManifest) goes through the
      // ordinary install question (install-runner.ts's own doc on
      // `installFromStoreCrx`'s `skipPrompt`), drawn in the tab in front:
      // the hook call below waits for the person, so the panel is answered
      // while it runs. No native dialog may reach the screen in a test.
      await stubNativeDialogs(app)

      const hookPresent = await waitFor(async () => await app!.evaluate(
        () => typeof (globalThis as unknown as { __orivonDevExtensionsStore?: unknown }).__orivonDevExtensionsStore === 'object'
      ))
      check('the dev-only store hook is present in this e2e build', hookPresent)

      const validOutcome = await answeringWith(app, 'Add extension', app.evaluate(async (_electron, id: string) => {
        const store = (globalThis as unknown as { __orivonDevExtensionsStore: { installFromStore: (id: string) => Promise<{ installed: boolean, reason?: string }> } }).__orivonDevExtensionsStore
        return await store.installFromStore(id)
      }, valid.id))
      check('the publisher-signed fixture installs', validOutcome.installed, JSON.stringify(validOutcome))

      const loaded = await app.evaluate(({ session }, id: string) => session.defaultSession.extensions.getExtension(id) !== null, valid.id)
      check('the installed fixture actually loaded into the default session', loaded)

      const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const registryText = readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8')
      const parsed = parseRegistry(registryText)
      check('the registry parses (not corrupt)', !parsed.corrupt)
      const entry = parsed.entries.find((candidate) => candidate.id === valid.id)
      check('the installed fixture is recorded with source store', entry?.source.kind === 'store', JSON.stringify(entry))
      check('its updater is the store one', entry?.updater.kind === 'store', JSON.stringify(entry?.updater))

      const refusedOutcome = await answeringWith(app, 'Add extension', app.evaluate(async (_electron, id: string) => {
        const store = (globalThis as unknown as { __orivonDevExtensionsStore: { installFromStore: (id: string) => Promise<{ installed: boolean, reason?: string }> } }).__orivonDevExtensionsStore
        try {
          return await store.installFromStore(id)
        } catch (error) {
          return { installed: false, reason: String(error) }
        }
      }, noPublisher.id))
      check('a CRX with no publisher proof is refused', refusedOutcome.installed === false, JSON.stringify(refusedOutcome))
      const afterRefusal = parseRegistry(readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8'))
      const nothingWritten = afterRefusal.entries.every((candidate) => candidate.id !== noPublisher.id)
      check('nothing was written to the registry for the refused CRX', nothingWritten, JSON.stringify(afterRefusal.entries.map((e) => e.id)))
      const notLoaded = await app.evaluate(({ session }, id: string) => session.defaultSession.extensions.getExtension(id) === null, noPublisher.id)
      check('the refused CRX did not load into the session either', notLoaded)
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0, JSON.stringify(await noNativeDialogs(app)))

      // A page at a non-store origin sees no chrome.webstorePrivate: the
      // vendored preload runs in every frame (a `frame`-type preload), and
      // UPSTREAM.md patch 5 is exactly the guard that must keep it inert
      // everywhere except the store's own top frame.
      const view = await navigateToFixture(app, `${origin}/`, 'extensions-store-fixture')
      const exposed = await evaluateRetrying(view, () => typeof (window as unknown as { chrome?: { webstorePrivate?: unknown } }).chrome?.webstorePrivate)
      check('chrome.webstorePrivate is not exposed on a non-store origin', exposed === 'undefined', exposed)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
