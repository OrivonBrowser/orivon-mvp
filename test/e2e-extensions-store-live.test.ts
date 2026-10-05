// A Chrome Web Store install of a real-shaped extension into a RUNNING
// browser: a web tab is open, and the extension has a module service worker,
// an onInstalled welcome tab, an offscreen document, run-time content scripts
// and a static DNR ruleset. e2e-extensions-store.test.ts installs a manifest
// only, so none of this ran there. Fixture: test/apps/extensions/store-live/.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-store-live.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './support/e2e-helpers.js'
import { parseRegistry } from '../src/main/extensions/registry.js'
import { buildFolderCrx, makeRsaKeyPair } from './store-crx-support.js'
import { answeringWith, noNativeDialogs, stubNativeDialogs } from './support/question-support.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/store-live/', import.meta.url)).replace(/[/\\]$/, '')
const TEST_TIMEOUT_MS = 120_000
const AFTER_INSTALL_MS = 10_000

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('installs a service-worker extension from the store into a running browser, and it keeps working', async () => {
  const crx = buildFolderCrx(FIXTURE_DIR, makeRsaKeyPair(), makeRsaKeyPair())
  const httpServer = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === `/${crx.id}.crx`) {
      res.writeHead(200, { 'content-type': 'application/x-chrome-extension' })
      res.end(crx.bytes)
    } else if (url.startsWith('/store-live-blocked')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__blockedRan = true')
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>store-live-page</title><script src="/store-live-blocked.js" onerror="window.__blocked = true"></script><body>page</body>')
    }
  })
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve) })
  server = httpServer
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  const origin = `http://127.0.0.1:${String(address.port)}`

  await runPhase('chrome web store live install', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_STORE_BASE_URL: origin, ORIVON_TEST_STORE_PUBLISHER_KEY_HASH: crx.publisherKeyHash },
        sandbox: true
      })
      const liveApp = app
      let exited = false
      liveApp.process().on('exit', () => { exited = true })
      await stubNativeDialogs(liveApp)
      await liveApp.evaluate(() => {
        ;(globalThis as unknown as { __swLog: string[] }).__swLog = []
      })
      await liveApp.evaluate(({ session }) => {
        const store = (globalThis as unknown as { __swLog: string[] }).__swLog
        session.defaultSession.serviceWorkers.on('console-message', (_e, d) => { if (store.length < 40) store.push(`${String(d.level)} ${String(d.message).slice(0, 200)}`) })
      })

      // The one-time recovery reload (extension-sw-preload-recovery.ts) takes
      // longer here, so the first worker's welcome tab lands inside the window
      // where the extension is removed and not yet loaded again. The install's
      // own load is the first call; every later one is the recovery's. The
      // failed page loads are logged to show the window was really hit.
      await liveApp.evaluate(({ app: electronApp, session }) => {
        const failures: string[] = []
        ;(globalThis as unknown as { __loadFailures: string[] }).__loadFailures = failures
        electronApp.on('web-contents-created', (_event, wc) => {
          wc.on('did-fail-load', (_e, code, _description, url, isMainFrame) => { if (isMainFrame) failures.push(`${String(code)} ${url}`) })
        })
        const extensions = session.defaultSession.extensions as unknown as { loadExtension: (path: string, options?: unknown) => Promise<unknown> }
        const original = extensions.loadExtension.bind(extensions)
        let calls = 0
        extensions.loadExtension = async (path, options) => {
          calls += 1
          if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 1500))
          return await original(path, options)
        }
      })

      // A web tab is open while the extension arrives.
      await navigateToFixture(app, `${origin}/`, 'store-live-page')
      await waitFor(async () => await liveApp.evaluate(() => typeof (globalThis as unknown as { __orivonDevExtensionsStore?: unknown }).__orivonDevExtensionsStore === 'object'))

      const outcome = await answeringWith(liveApp, 'Add extension', liveApp.evaluate(async (_electron, id: string) => {
        const store = (globalThis as unknown as { __orivonDevExtensionsStore: { installFromStore: (id: string) => Promise<{ installed: boolean, reason?: string }> } }).__orivonDevExtensionsStore
        return await store.installFromStore(id)
      }, crx.id))
      check('the store install succeeds', outcome.installed, JSON.stringify(outcome))

      await new Promise((resolve) => setTimeout(resolve, AFTER_INSTALL_MS))
      check('the browser is still running ten seconds after the install', !exited && liveApp.process().exitCode === null)
      if (exited) return

      const welcome = await liveApp.evaluate(({ webContents }, id: string) =>
        webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.getURL() === `chrome-extension://${id}/welcome.html`), crx.id)
      check('the welcome tab the worker opens from onInstalled is open', welcome)

      const offscreen = await liveApp.evaluate(({ webContents }, id: string) =>
        webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.getURL() === `chrome-extension://${id}/offscreen.html`), crx.id)
      check('the offscreen document the worker creates is open', offscreen)

      const log = await liveApp.evaluate(() => (globalThis as unknown as { __swLog: string[] }).__swLog)
      check('onInstalled reached the worker once, as an install', log.filter((line) => line.includes('installed:{"reason":"install"}')).length === 1, log.join(' | '))
      check('getManifest still lists the static rulesets the extension shipped', log.some((line) => line.includes('rulesets:static')), log.join(' | '))
      check('the service worker raised no uncaught error', !log.some((line) => line.includes('Uncaught')), log.join(' | '))

      const userData = await liveApp.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const entry = parseRegistry(readFileSync(join(userData, 'extensions', 'registry.json'), 'utf8')).entries.find((candidate) => candidate.id === crx.id)
      check('the registry records the extension as installed, not updated', entry?.updater.kind === 'store' && entry.updater.lastResult === 'installed', JSON.stringify(entry?.updater))

      // The first worker can open the welcome tab while the one-time recovery
      // reload (extension-sw-preload-recovery.ts) is removing and loading the
      // extension again; the page is navigated again once that reload is
      // done, so the page that counts is the one that has its APIs.
      const welcomeUrl = `chrome-extension://${crx.id}/welcome.html`
      const welcomeHasApis = async (): Promise<boolean> => await liveApp.evaluate(({ webContents }, url: string) => {
        const page = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL() === url)
        if (page === undefined) return false
        return page.executeJavaScript('typeof chrome.scripting?.getRegisteredContentScripts === "function"').then((has) => has === true, () => false)
      }, welcomeUrl)
      const settled = await waitFor(welcomeHasApis, 10_000).catch(() => false)
      const failures = await liveApp.evaluate(() => (globalThis as unknown as { __loadFailures: string[] }).__loadFailures)
      check('the welcome tab has the extension APIs once the recovery reload is done', settled, failures.join(' | '))

      const registered = await liveApp.evaluate(({ webContents }, id: string) => {
        const page = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL() === `chrome-extension://${id}/welcome.html`)
        if (page === undefined) return -1
        return page.executeJavaScript('chrome.scripting.getRegisteredContentScripts().then((s) => s.length)') as Promise<number>
      }, crx.id)
      check('the worker registered its content script', registered === 1, String(registered))

      // The static ruleset the install loaded blocks in the same process, no restart.
      const second = await navigateToFixture(app, `${origin}/?second`, 'store-live-page')
      const blocked = await waitFor(async () => await evaluateRetrying(second, () => Boolean((window as unknown as { __blocked?: boolean }).__blocked)), 10_000).catch(() => false)
      check('the static ruleset blocks a script on the next page, with no restart', blocked)
      check('no native message box was opened', (await noNativeDialogs(liveApp)).length === 0, JSON.stringify(await noNativeDialogs(liveApp)))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
