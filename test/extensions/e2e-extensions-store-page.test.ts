// Installing from the Chrome Web Store's own page, the real route: `chrome.webstorePrivate.beginInstallWithManifest3`
// from a page at the store's origin, the question in the store tab, the download, Orivon's install. The page keeps
// asking `getExtensionStatus` while it runs, and the main process must stay up through every load that happens
// beside it: an extension load makes the renderer rebuild `chrome`, and the store page must keep its own
// `chrome.webstorePrivate` through that. `protocol.handle('https')` serves the store host only; the CRX
// downloads come from a local fixture server through the test seam. Fixtures: test/apps/extensions/store-live/,
// store-page/ and action-popup/.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-store-page.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { parseRegistry } from '../../src/main/extensions/registry.js'
import { FIXTURES_DIR } from '../support/extensions-fixtures.js'
import { buildFolderCrx, makeRsaKeyPair } from './store-crx-support.js'
import { answeringWith, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import { waitRecovered } from './extensions-e2e-helpers.js'

const FIXTURE = (name: string): string => join(FIXTURES_DIR, name)
const TEST_TIMEOUT_MS = 240_000
const AFTER_INSTALL_MS = 10_000
const STORE_ORIGIN = 'https://chromewebstore.google.com'
const REBUILD_ERROR = 'Failed to create API on Chrome object'
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const STORE_PAGE = `<!doctype html><title>cws-fixture</title><body>store</body><script>
  const api = () => window.chrome && window.chrome.webstorePrivate ? window.chrome.webstorePrivate : window.electronWebstore
  window.__install = (details) => api().beginInstallWithManifest3(details)
  window.__status = (id, manifest) => api().getExtensionStatus(id, manifest)
  window.__owns = () => Boolean(window.chrome) && window.chrome.webstorePrivate === window.electronWebstore
  window.__uninstall = (id) => new Promise((resolve) => window.chrome.management.uninstall(id, { showConfirmDialog: false }, resolve))
</script>`

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Store { readonly id: string, readonly manifest: string, readonly name: string }

type Launched = Awaited<ReturnType<typeof launchElectron>>

async function serveStoreHost (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }, page: string) => {
    session.defaultSession.protocol.handle('https', (request) => {
      if (new URL(request.url).host !== 'chromewebstore.google.com') return new Response('', { status: 404 })
      return new Response(page, { headers: { 'content-type': 'text/html' } })
    })
  }, STORE_PAGE)
}

function storeDetails (item: Store): Record<string, unknown> {
  return { id: item.id, manifest: item.manifest, localizedName: item.name, esbAllowlist: true, iconUrl: ICON }
}

/** Collects what a page logs, to say afterwards whether its bindings rebuild failed. */
function listen (page: Page): string[] {
  const lines: string[] = []
  page.on('console', (message) => { lines.push(message.text()) })
  return lines
}

it('keeps the browser up through store installs, loads beside an open store tab, and a closed tab', async () => {
  const publisher = makeRsaKeyPair()
  const items = ['store-live', 'store-page'].map((name): Store & { crx: ReturnType<typeof buildFolderCrx> } => {
    const crx = buildFolderCrx(FIXTURE(name), makeRsaKeyPair(), publisher)
    const manifest = readFileSync(join(FIXTURE(name), 'manifest.json'), 'utf8')
    return { id: crx.id, manifest, name: (JSON.parse(manifest) as { name: string }).name, crx }
  })
  const publisherKeyHash = items[0]!.crx.publisherKeyHash
  const httpServer = createServer((req, res) => {
    const hit = items.find((item) => req.url === `/${item.id}.crx`)
    if (hit === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/x-chrome-extension' })
    res.end(hit.crx.bytes)
  })
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve) })
  server = httpServer
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  const origin = `http://127.0.0.1:${String(address.port)}`

  await runPhase('chrome web store page installs', async (check) => {
    let app: Launched | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_STORE_BASE_URL: origin, ORIVON_TEST_STORE_PUBLISHER_KEY_HASH: publisherKeyHash },
        sandbox: true
      })
      const liveApp = app
      let exited = false
      liveApp.process().on('exit', () => { exited = true })
      await stubNativeDialogs(liveApp)
      await serveStoreHost(liveApp)
      const userData = await liveApp.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const registry = (): ReturnType<typeof parseRegistry>['entries'] => parseRegistry(readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8')).entries
      const alive = (): boolean => !exited && liveApp.process().exitCode === null

      /** Five status polls in three seconds, the page's own pace while its install button spins. */
      const poll = async (view: Page, id: string, manifest: string, expected: string, label: string): Promise<void> => {
        const answers: unknown[] = []
        for (let i = 0; i < 5 && alive(); i++) {
          answers.push(await view.evaluate(async ([extensionId, text]) => await (window as unknown as { __status: (a: string, b: string) => Promise<string> }).__status(extensionId!, text!), [id, manifest]).catch((error: unknown) => `threw: ${String(error)}`))
          await delay(600)
        }
        check(`${label}: every status poll answers "${expected}"`, answers.length === 5 && answers.every((answer) => answer === expected), JSON.stringify(answers))
      }
      const owns = async (view: Page): Promise<boolean> => await view.evaluate(() => (window as unknown as { __owns: () => boolean }).__owns()).catch(() => false)

      // 1: each store install, with the store tab open all along.
      for (const item of items) {
        const view = await navigateToFixture(liveApp, `${STORE_ORIGIN}/detail/fixture/${item.id}`, 'cws-fixture')
        const logged = listen(view)
        const result = await answeringWith(liveApp, 'Add extension', view.evaluate(async (details: Record<string, unknown>) => await (window as unknown as { __install: (d: unknown) => Promise<unknown> }).__install(details), storeDetails(item)))
        check(`${item.name}: the page's install call answers success`, result === 'success', JSON.stringify(result))
        await waitRecovered(liveApp, 8_000)
        await poll(view, item.id, item.manifest, 'enabled', item.name)
        check(`${item.name}: the page still owns chrome.webstorePrivate`, await owns(view))
        await delay(AFTER_INSTALL_MS)
        check(`${item.name}: the browser is up ten seconds after the install`, alive())
        if (!alive()) return
        check(`${item.name}: the registry records a store entry`, registry().some((entry) => entry.id === item.id && entry.source.kind === 'store'))
        console.log(`[store-page] ${item.name}: the store tab logged the bindings error: ${String(logged.some((line) => line.includes(REBUILD_ERROR)))}`)
      }

      // 2: with the store tab open, extensions load, are disabled and enabled beside it.
      const view = await navigateToFixture(liveApp, `${STORE_ORIGIN}/detail/fixture/${items[0]!.id}`, 'cws-fixture')
      const outcome = await answeringWith(liveApp, 'Add extension', liveApp.evaluate(async (_electron, dir: string) => {
        const hook = (globalThis as unknown as { __orivonDevExtensionsInstall?: { installFromFolder: (dir: string) => Promise<{ installed: boolean, entry?: { id: string } }> } }).__orivonDevExtensionsInstall
        if (hook === undefined) throw new Error('the install test hook is not installed: build with scripts/build-e2e.mjs')
        return await hook.installFromFolder(dir)
      }, FIXTURE('action-popup')))
      check('a folder install beside the open store tab succeeds', outcome.installed, JSON.stringify(outcome))
      const folderId = outcome.entry?.id ?? ''
      await poll(view, items[0]!.id, items[0]!.manifest, 'enabled', 'after a folder install')
      const path = registry().find((entry) => entry.id === folderId)?.path ?? ''
      await liveApp.evaluate(async ({ session }, [id, dir]: [string, string]) => {
        const extensions = session.defaultSession.extensions
        extensions.removeExtension(id)
        await new Promise((resolve) => setTimeout(resolve, 300))
        await extensions.loadExtension(dir, { allowFileAccess: false })
      }, [folderId, path] as [string, string])
      await poll(view, items[0]!.id, items[0]!.manifest, 'enabled', 'after a disable and an enable')
      check('the page still owns chrome.webstorePrivate after the loads', await owns(view))
      await delay(AFTER_INSTALL_MS)
      check('the browser is up ten seconds after the loads', alive())
      if (!alive()) return

      // 3: an uninstall from the page, then the store tab closed. The reply to a closed tab (patch 10 of the store
      // library) is pinned by store-api-uninstall.test.ts: its send runs right after the removal, before any tab can be
      // closed from here, so this step shows that the browser survives the removal and the close.
      const uninstalling = answeringWith(liveApp, 'Remove', view.evaluate(async (id: string) => await (window as unknown as { __uninstall: (a: string) => Promise<unknown> }).__uninstall(id), items[1]!.id).catch(() => 'page closed'))
      await waitFor(() => registry().every((entry) => entry.id !== items[1]!.id), 20_000).catch(() => false)
      const chrome = findChrome(liveApp)
      const [tab] = await tabIds(chrome) as string[]
      if (tab !== undefined) await chrome.click(`[data-id="${tab}"] .close`).catch(() => {})
      await uninstalling.catch(() => {})
      await delay(3_000)
      check('the browser is up after an uninstall and a tab close', alive())
      check('the extension was removed', registry().every((entry) => entry.id !== items[1]!.id))
      check('no native message box was opened', (await noNativeDialogs(liveApp)).length === 0, JSON.stringify(await noNativeDialogs(liveApp)))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

it('serves the store page its own API in a private window, and refuses the install with no question', async () => {
  const crx = buildFolderCrx(FIXTURE('store-page'), makeRsaKeyPair(), makeRsaKeyPair())
  const manifest = readFileSync(join(FIXTURE('store-page'), 'manifest.json'), 'utf8')
  const item: Store = { id: crx.id, manifest, name: 'Orivon E2E Store Page' }

  await runPhase('chrome web store page in a private window', async (check) => {
    let app: Launched | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER, '--orivon-private'], sandbox: true })
      const liveApp = app
      let exited = false
      liveApp.process().on('exit', () => { exited = true })
      await stubNativeDialogs(liveApp)
      await serveStoreHost(liveApp)
      const view = await navigateToFixture(liveApp, `${STORE_ORIGIN}/detail/fixture/${item.id}`, 'cws-fixture')
      check('the private store page owns chrome.webstorePrivate', await view.evaluate(() => (window as unknown as { __owns: () => boolean }).__owns()))
      const answers: unknown[] = []
      for (let i = 0; i < 5 && !exited; i++) {
        answers.push(await view.evaluate(async ([id, text]: [string, string]) => await (window as unknown as { __status: (a: string, b: string) => Promise<string> }).__status(id, text), [item.id, item.manifest] as [string, string]).catch((error: unknown) => `threw: ${String(error)}`))
        await delay(600)
      }
      check('every status poll answers "blocked_by_policy"', answers.every((answer) => answer === 'blocked_by_policy'), JSON.stringify(answers))
      const result = await view.evaluate(async (details: Record<string, unknown>) => await (window as unknown as { __install: (d: unknown) => Promise<unknown> }).__install(details), storeDetails(item))
      check('the install is refused by the private runtime, with no question', result === 'blocked_by_policy', JSON.stringify(result))
      await delay(AFTER_INSTALL_MS)
      check('the browser is up ten seconds later', !exited && liveApp.process().exitCode === null)
      check('no native message box was opened', (await noNativeDialogs(liveApp)).length === 0)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
