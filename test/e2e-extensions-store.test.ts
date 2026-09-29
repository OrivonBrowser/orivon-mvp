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
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-store.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto'
import AdmZip from 'adm-zip'
import Pbf from 'pbf'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { parseRegistry } from '../src/main/extensions/registry.js'
import { convertHexadecimalToIDAlphabet } from '../vendor/electron-chrome-web-store/src/browser/id.js'

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

interface KeyPair { readonly publicKey: Buffer, readonly privateKey: KeyObject }

function makeRsaKeyPair (): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  })
  return { publicKey: Buffer.from(publicKey), privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }) }
}

const SIGNED_DATA_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary')

function writeProof (obj: { publicKey: Buffer, signature: Buffer }, pbf: Pbf): void {
  pbf.writeBytesField(1, obj.publicKey)
  pbf.writeBytesField(2, obj.signature)
}

/** A CRX3 file, signed by `dev` and, when `publisher` is given, also by it
 * -- the second proof is what `requirePublisherProof: true` needs
 * (crx.test.ts's own doc); omitting it is how this file builds the "refused"
 * fixture. */
function buildCrx (manifest: Record<string, unknown>, dev: KeyPair, publisher?: KeyPair): { bytes: Buffer, id: string } {
  const archiveZip = new AdmZip()
  archiveZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const archive = archiveZip.toBuffer()

  const crxId = createHash('sha256').update(dev.publicKey).digest().subarray(0, 16)
  const signedHeaderData = (() => {
    const pbf = new Pbf()
    pbf.writeBytesField(1, crxId)
    return Buffer.from(pbf.finish())
  })()
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0)
  const dataToVerify = Buffer.concat([SIGNED_DATA_CONTEXT, lengthPrefix, signedHeaderData, archive])

  const proofs: KeyPair[] = publisher === undefined ? [dev] : [dev, publisher]
  const header = (() => {
    const pbf = new Pbf()
    for (const proof of proofs) {
      pbf.writeMessage(2, writeProof, { publicKey: proof.publicKey, signature: signWithKey('sha256', dataToVerify, proof.privateKey) })
    }
    pbf.writeBytesField(10000, signedHeaderData)
    return Buffer.from(pbf.finish())
  })()

  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'binary')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return { bytes: Buffer.concat([prefix, header, archive]), id: convertHexadecimalToIDAlphabet(crxId.toString('hex')) }
}

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
      // ordinary install prompt (install-runner.ts's own doc on
      // `installFromStoreCrx`'s `skipPrompt`), the real
      // `dialog.showMessageBox` -- stubbed to always accept, this repo's
      // hard rule that no native dialog may reach the screen in a test.
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
      })

      const hookPresent = await waitFor(async () => await app!.evaluate(
        () => typeof (globalThis as unknown as { __orivonDevExtensionsStore?: unknown }).__orivonDevExtensionsStore === 'object'
      ))
      check('the dev-only store hook is present in this e2e build', hookPresent)

      const validOutcome = await app.evaluate(async (_electron, id: string) => {
        const store = (globalThis as unknown as { __orivonDevExtensionsStore: { installFromStore: (id: string) => Promise<{ installed: boolean, reason?: string }> } }).__orivonDevExtensionsStore
        return await store.installFromStore(id)
      }, valid.id)
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

      const refusedOutcome = await app.evaluate(async (_electron, id: string) => {
        const store = (globalThis as unknown as { __orivonDevExtensionsStore: { installFromStore: (id: string) => Promise<{ installed: boolean, reason?: string }> } }).__orivonDevExtensionsStore
        try {
          return await store.installFromStore(id)
        } catch (error) {
          return { installed: false, reason: String(error) }
        }
      }, noPublisher.id)
      check('a CRX with no publisher proof is refused', refusedOutcome.installed === false, JSON.stringify(refusedOutcome))
      const afterRefusal = parseRegistry(readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8'))
      const nothingWritten = afterRefusal.entries.every((candidate) => candidate.id !== noPublisher.id)
      check('nothing was written to the registry for the refused CRX', nothingWritten, JSON.stringify(afterRefusal.entries.map((e) => e.id)))
      const notLoaded = await app.evaluate(({ session }, id: string) => session.defaultSession.extensions.getExtension(id) === null, noPublisher.id)
      check('the refused CRX did not load into the session either', notLoaded)

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
