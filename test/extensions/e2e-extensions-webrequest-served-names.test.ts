// A name Orivon's own protocols serve is Orivon's to load and to fail: an extension hears no error of a
// navigation to one, so it cannot take the tab to a gateway or a page of its own the way a name-resolution
// extension does when a top-level `.eth` request fails. Every other event of those requests, and the errors
// of every other host, still reach it.
//
// Fixture: test/apps/extensions/webrequest-served-names/ (a name-resolution extension's own error listener,
// `*://*.eth/*` on `main_frame`, that calls `chrome.tabs.update`, plus listeners that record every
// main-frame and sub-frame event). The name is served from the fixture gateway through the dev resolver
// seam (test/web3/e2e-eth-verified.test.ts). Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-webrequest-served-names.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { seedFixture } from './extensions-e2e-helpers.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>served name fixture</title><body>served</body>' }
const TEST_TIMEOUT_MS = 240_000
/** How long a takeover would take to show after the failing request: the extension answers an event, then asks for the update. */
const SETTLE_MS = 3_000

interface Heard { readonly event: string, readonly url: string, readonly type: string, readonly tabId: number, readonly error?: string }
interface Takeover { readonly url: string, readonly error?: string, readonly tabId: number }
interface Nav { readonly id: number, readonly session: string, readonly ev: string, readonly url: string, readonly mainFrame?: boolean, readonly code?: number, readonly desc?: string }

let plain: Server | undefined

afterAll(async () => {
  if (plain !== undefined) await new Promise<void>((resolve) => { plain?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Records what every page's navigation does in the main process, so a failure the extension is not told of is still seen. */
async function watchNavigations (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, session, webContents }) => {
    const log: Nav[] = []
    ;(globalThis as { __navLog?: Nav[] }).__navLog = log
    const attach = (contents: Electron.WebContents): void => {
      const label = contents.session === session.defaultSession ? 'default' : 'other'
      const note = (ev: string, url: string, extra: { mainFrame?: boolean, code?: number, desc?: string } = {}): void => {
        if (url.startsWith('chrome-extension:') || url.startsWith('orivon-shell:')) return
        log.push({ id: contents.id, session: label, ev, url, ...extra })
      }
      contents.on('did-start-navigation', (...args: unknown[]) => {
        const details = args[0] as { url?: string, isMainFrame?: boolean }
        note('start', typeof args[1] === 'string' ? args[1] : details.url ?? '', { mainFrame: typeof args[3] === 'boolean' ? args[3] : details.isMainFrame ?? false })
      })
      contents.on('did-redirect-navigation', (...args: unknown[]) => {
        const details = args[0] as { url?: string }
        note('redirect', typeof args[1] === 'string' ? args[1] : details.url ?? '')
      })
      contents.on('did-navigate', (_event, url) => { note('navigate', url) })
      contents.on('did-fail-load', (_event, code, desc, url, mainFrame) => { note('fail', url, { code, desc, mainFrame }) })
    }
    for (const existing of webContents.getAllWebContents()) attach(existing)
    electronApp.on('web-contents-created', (_event, contents) => { attach(contents) })
  })
}

async function navLog (app: ElectronApplication): Promise<Nav[]> {
  return await app.evaluate(() => (globalThis as { __navLog?: Nav[] }).__navLog ?? [])
}

/** What the extension's background pages (one per session that loaded it) heard and did. */
async function readExtension (app: ElectronApplication, id: string): Promise<{ heard: Heard[], takeovers: Takeover[], ready: boolean, urls: string[] }> {
  return await app.evaluate(async ({ webContents }, extensionId: string) => {
    const all = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed())
    const heard: Heard[] = []
    const takeovers: Takeover[] = []
    let ready = false
    for (const contents of all) {
      if (!contents.getURL().startsWith(`chrome-extension://${extensionId}/`)) continue
      const state = await contents.executeJavaScript('JSON.stringify({ ready: window.__ready === true, heard: window.__heard ?? [], takeovers: window.__takeovers ?? [] })').catch(() => undefined) as string | undefined
      if (state === undefined) continue
      const parsed = JSON.parse(state) as { ready: boolean, heard: Heard[], takeovers: Takeover[] }
      ready ||= parsed.ready
      heard.push(...parsed.heard)
      takeovers.push(...parsed.takeovers)
    }
    return { heard, takeovers, ready, urls: all.map((contents) => contents.getURL()).filter((url) => !url.startsWith('orivon-shell:')) }
  }, id)
}

async function typeAddress (app: ElectronApplication, url: string): Promise<void> {
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  await clickAddressBarRetrying(chrome, url)
}

it('keeps a name Orivon serves out of reach of an extension that takes a tab elsewhere when the load fails, and still tells it of every other host', async () => {
  await runPhase('webrequest served names', async (check) => {
    const gateway = await startFixtureGateway({ site: SITE })
    const plainServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>plain fixture</title><body>plain</body>') })
    plain = plainServer
    await new Promise<void>((resolve) => { plainServer.listen(0, '127.0.0.1', resolve) })
    const plainOrigin = `http://127.0.0.1:${String((plainServer.address() as AddressInfo).port)}`
    // A port nothing listens on: the load of a host Orivon does not serve fails, and the extension is told.
    const refusing = createServer()
    await new Promise<void>((resolve) => { refusing.listen(0, '127.0.0.1', resolve) })
    const refusedUrl = `http://127.0.0.1:${String((refusing.address() as AddressInfo).port)}/`
    await new Promise<void>((resolve) => { refusing.close(() => { resolve() }) })

    let app: ElectronApplication | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'fixture.eth': `ipfs://${gateway.roots['site']!}` }), ORIVON_TEST_IPFS_GATEWAYS: gateway.url },
        seedProfile: async (dir) => { extensionId = seedFixture(dir, 'webrequest-served-names') },
        sandbox: true
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      await watchNavigations(app)

      const ready = await waitFor(async () => (await readExtension(running, extensionId)).ready, 20_000)
      check('the extension\'s background page registered its listeners', ready)

      // A request the extension hears proves its listeners are in force: they are registered in order, the takeover listener first.
      await navigateToFixture(app, `${plainOrigin}/`, 'plain fixture')
      const warmed = await waitFor(async () => (await readExtension(running, extensionId)).heard.some((entry) => entry.event === 'onCompleted' && entry.url.startsWith(plainOrigin)), 20_000)
      check('the extension heard the plain page\'s main-frame load', warmed)

      let loadError = ''
      try {
        await navigateToFixture(app, 'https://fixture.eth/', 'served name fixture')
      } catch (error) {
        loadError = String(error)
      }
      check('the name loaded in its tab', loadError === '', loadError)
      await delay(SETTLE_MS)
      const loaded = await readExtension(running, extensionId)
      const ethHeard = loaded.heard.filter((entry) => new URL(entry.url).hostname.endsWith('.eth'))
      check('the name stayed in its tab', loaded.urls.some((url) => url === 'https://fixture.eth/') && !loaded.urls.some((url) => url.endsWith('/taken.html')), JSON.stringify(loaded.urls))
      check('no .eth main-frame error reached the extension, so nothing took the tab', loaded.takeovers.length === 0 && !ethHeard.some((entry) => entry.event === 'onErrorOccurred'), JSON.stringify({ takeovers: loaded.takeovers, ethHeard }))
      check('a blocker still sees the name\'s other events', ['onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onResponseStarted', 'onCompleted'].every((event) => ethHeard.some((entry) => entry.event === event && entry.type === 'main_frame' && entry.url === 'https://fixture.eth/')), JSON.stringify(ethHeard.map((entry) => entry.event)))

      // The same name over plain http and on a port nothing listens on: both loads fail inside Orivon, and neither is the extension's to answer.
      for (const failing of ['http://fixture.eth/', 'https://fixture.eth:1/']) {
        await typeAddress(app, failing)
        const failed = await waitFor(async () => (await navLog(running)).some((nav) => nav.ev === 'fail' && nav.mainFrame === true && nav.url === failing), 20_000)
        await delay(SETTLE_MS)
        const after = await readExtension(running, extensionId)
        const failures = (await navLog(running)).filter((nav) => nav.url === failing && (nav.ev === 'fail' || nav.ev === 'redirect'))
        check(`${failing} failed in Orivon's own load`, failed, JSON.stringify(failures))
        check(`${failing}: the extension heard no error and took no tab`, after.takeovers.length === 0 && !after.heard.some((entry) => entry.event === 'onErrorOccurred' && entry.url === failing) && !after.urls.some((url) => url.endsWith('/taken.html')), JSON.stringify({ takeovers: after.takeovers, errors: after.heard.filter((entry) => entry.event === 'onErrorOccurred') }))
      }

      // Another host's failure is still told, so a blocker or a monitor keeps its picture of the web.
      await typeAddress(app, refusedUrl)
      const told = await waitFor(async () => (await readExtension(running, extensionId)).heard.some((entry) => entry.event === 'onErrorOccurred' && entry.type === 'main_frame' && entry.url === refusedUrl), 20_000)
      check('the error of a host Orivon does not serve still reached the extension', told, JSON.stringify((await readExtension(running, extensionId)).heard.filter((entry) => entry.event === 'onErrorOccurred')))

    } finally {
      if (app !== undefined) {
        const evidence = await Promise.all([readExtension(app, extensionId), navLog(app)]).catch(() => undefined)
        if (evidence !== undefined) console.log(JSON.stringify({ extension: evidence[0], navigations: evidence[1] }, null, 1))
        await closeElectronApp(app)
      }
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
