// An extension works on a page whose origin holds Orivon permissions exactly as on any other website:
// its webRequest listeners see the page's requests and block them, its declarativeNetRequest rules block
// there, its page right-click item shows, and chrome.tabCapture captures the tab. What stays: code an
// extension runs is still refused by window.orivon (ADR-0045), on the very page it now reaches.
//
// The page is granted with the developer-only hook before it is opened (as e2e-extensions-orivon-filter
// does it), so it carries the granted-origin policy: no inline script, so every script here is a file.
//
// Run with:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-on-granted-pages.test.ts
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.extensions-granted-page-e2e',
  name: 'Extensions on a granted page e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: {}
}

const servers: Server[] = []

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Seen { readonly url: string, readonly headers: IncomingHttpHeaders }

const PAGE_HTML = '<!doctype html><title>granted-page-fixture</title><body>granted<script src="/orivon-fixture/page.js"></script></body>'

// The extension's addListener calls reach main over IPC after its background page ran them, so the page asks for a
// URL the extension cancels until one is refused: from then on its listeners are in force.
const PAGE_JS = `(async () => {
  const data = document.documentElement.dataset
  const outcomeOf = (error) => (error && typeof error === 'object' && typeof error.code === 'string') ? error.code : String(error)
  const load = (src) => new Promise((resolve) => {
    const script = document.createElement('script')
    script.onload = () => resolve('ran')
    script.onerror = () => resolve('blocked')
    script.src = src
    document.head.append(script)
  })
  try { await window.orivon.app.manifest(); data.orivonPage = 'allowed' } catch (error) { data.orivonPage = outcomeOf(error) }
  for (let n = 0; n < 200; n++) {
    try { await fetch('/wr-ads/ping?' + n) } catch { data.wrActive = 'yes'; break }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  data.wrScript = await load('/wr-ads/x.js')
  data.dnrScript = await load('/ads/blocked.js')
  data.wrEcho = await fetch('/wr-echo').then((response) => response.text()).catch((error) => 'error:' + String(error))
  data.settled = 'yes'
})()`

const AUDIO_JS = `const ctx = new AudioContext()
const oscillator = ctx.createOscillator()
const gain = ctx.createGain()
gain.gain.value = 0.01
oscillator.connect(gain)
gain.connect(ctx.destination)
oscillator.start()
window.__ctx = ctx`

async function startServer (seen: Seen[] = []): Promise<{ server: Server, origin: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    seen.push({ url, headers: req.headers })
    if (url === '/orivon-fixture/page.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(PAGE_JS)
    } else if (url === '/orivon-fixture/audio.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(AUDIO_JS)
    } else if (url.startsWith('/wr-ads/') || url.startsWith('/ads/')) {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end('window.__adRan = true;')
    } else if (url.startsWith('/wr-echo')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(String(req.headers['x-wr-test'] ?? 'missing'))
    } else if (url.startsWith('/orivon-fixture/audio')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>granted-audio-fixture</title><body><script src="/orivon-fixture/audio.js"></script></body>')
    } else if (url.startsWith('/orivon-fixture/')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE_HTML)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

/** Registers `origin` as an app and grants it the id capability, before any page of it is opened. */
async function grantOrigin (app: ElectronApplication, origin: string): Promise<boolean> {
  return await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook(request)
    return true
  }, { origin, manifest: MANIFEST, capability: 'id', patterns: [] } satisfies DevGrantRequest)
}

interface LogEntry { readonly event: string, readonly url: string, readonly type: string, readonly tabId: number, readonly error?: string }

type MenuHolder = { __orivonLastMenu?: { items: Array<{ label: string, type: string }> } | undefined }

const TEST_TIMEOUT_MS = 180_000

describe('extensions on a page whose origin holds Orivon permissions', () => {
  it('[app:extensions-reach-a-site-that-holds-permissions] webRequest sees and blocks its requests, declarativeNetRequest blocks there, and window.orivon still refuses extension code', async () => {
    const seen: Seen[] = []
    const started = await startServer(seen)

    await runPhase('extensions on a granted page: requests', async (check) => {
      let app: ElectronApplication | undefined
      try {
        const ids = { webRequest: '', caller: '' }
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER],
          seedProfile: async (dir) => {
            ids.webRequest = seedFixture(dir, 'webrequest-mv2')
            seedFixture(dir, 'dnr-blocker')
            ids.caller = seedFixture(dir, 'orivon-caller')
          },
          sandbox: true
        })
        const liveApp = app
        check('the three fixture extensions are loaded', await waitFor(async () => (await liveApp.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 3))
        check('the developer-only grant hook is installed and the origin is granted', await grantOrigin(app, started.origin))

        const backgroundReady = await waitFor(async () => await liveApp.evaluate(async ({ webContents }, id: string) => {
          const background = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(`chrome-extension://${id}/`))
          return await background?.executeJavaScript('window.__wrReady === true').catch(() => false) === true
        }, ids.webRequest), 20_000)
        check('the webRequest extension\'s background page registered its listeners', backgroundReady)

        const view = await navigateToFixture(app, `${started.origin}/orivon-fixture/`, 'granted-page-fixture')
        const settled = await waitFor(async () => await evaluateRetrying(view, () => document.documentElement.dataset.settled) === 'yes', 40_000)
        const data = await evaluateRetrying(view, () => ({ ...document.documentElement.dataset }))
        check('the granted page finished its probes', settled, JSON.stringify(data))

        check('the page is granted: its own window.orivon call succeeds', data.orivonPage === 'allowed', JSON.stringify(data))
        check('the webRequest extension\'s listeners came into force on the granted page (a /wr-ads/ request was refused)', data.wrActive === 'yes', JSON.stringify(data))
        check('a blocking onBeforeRequest listener cancelled a script of the granted page', data.wrScript === 'blocked', JSON.stringify(data))
        check('a declarativeNetRequest static rule blocked a script of the granted page', data.dnrScript === 'blocked', JSON.stringify(data))
        check('a blocking onBeforeSendHeaders listener added its header to the granted page\'s request', data.wrEcho === '1', JSON.stringify(data))
        check('the server saw that header on the request itself', seen.some((entry) => entry.url.startsWith('/wr-echo') && entry.headers['x-wr-test'] === '1'))
        check('the cancelled requests never reached the server', !seen.some((entry) => entry.url.startsWith('/wr-ads/x.js') || entry.url.startsWith('/ads/blocked.js')))

        const tabId = await liveApp.evaluate(({ webContents }, url: string) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.id ?? -2, `${started.origin}/orivon-fixture/`)
        const readLog = async (): Promise<LogEntry[]> => await liveApp.evaluate(async ({ webContents }, id: string) => {
          const background = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(`chrome-extension://${id}/`))
          return JSON.parse(await background?.executeJavaScript('JSON.stringify(window.__wrLog)') ?? '[]') as LogEntry[]
        }, ids.webRequest)
        const observed = await waitFor(async () => {
          const log = await readLog()
          return log.some((entry) => entry.event === 'onCompleted' && entry.type === 'main_frame' && entry.url === `${started.origin}/orivon-fixture/`)
        })
        const log = await readLog()
        check('an observer saw the granted page\'s own document load, against its tab', observed && log.some((entry) => entry.event === 'onCompleted' && entry.type === 'main_frame' && entry.tabId === tabId), JSON.stringify(log.filter((entry) => entry.type === 'main_frame')))
        check('an observer saw the granted page\'s fetch complete, against its tab', log.some((entry) => entry.event === 'onCompleted' && entry.url.endsWith('/wr-echo') && entry.tabId === tabId), JSON.stringify(log.map((entry) => [entry.event, entry.url])))
        check('an observer saw the cancelled script as blocked by the client', log.some((entry) => entry.event === 'onErrorOccurred' && entry.url.endsWith('/wr-ads/x.js') && entry.error?.includes('ERR_BLOCKED_BY_CLIENT') === true))

        await waitFor(async () => (await evaluateRetrying(view, () => document.documentElement.dataset.orivonMainWorld)) !== undefined, 20_000)
        const callerData = await evaluateRetrying(view, () => ({ ...document.documentElement.dataset }))
        check('extension code is still refused by window.orivon: the MAIN-world content script', callerData.orivonMainWorld === 'denied', JSON.stringify(callerData))
        check('extension code is still refused by window.orivon: the injected web-accessible script', callerData.orivonInjected === 'denied', JSON.stringify(callerData))
        await waitFor(async () => (await evaluateRetrying(view, () => document.documentElement.dataset.orivonScripting)) !== undefined, 20_000)
        const scripting = await evaluateRetrying(view, () => document.documentElement.dataset.orivonScripting)
        check('extension code is still refused by window.orivon: chrome.scripting in the MAIN world', scripting === 'denied', String(scripting))
        check('the page\'s own call is still allowed beside them', callerData.orivonPage === 'allowed', JSON.stringify(callerData))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  }, TEST_TIMEOUT_MS)

  it('[app:extensions-reach-a-site-that-holds-permissions] an extension\'s page right-click item is in the menu of the granted page', async () => {
    const started = await startServer()

    await runPhase('extensions on a granted page: right-click menu', async (check) => {
      let app: ElectronApplication | undefined
      try {
        let id = ''
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER],
          seedProfile: async (dir) => { id = seedFixture(dir, 'api-sweep') },
          sandbox: true
        })
        const liveApp = app
        check('the fixture extension is loaded', await waitFor(async () => (await liveApp.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1))
        await waitRecovered(app)
        check('the developer-only grant hook is installed and the origin is granted', await grantOrigin(app, started.origin))
        await liveApp.evaluate(({ Menu }) => {
          Menu.prototype.popup = function () { (globalThis as MenuHolder).__orivonLastMenu = this as never }
        })
        const extensionPage = await openExtensionPage(app, id, 'page.html')
        const created = await rpc(app, extensionPage, 'chrome.contextMenus.create', [{ id: 'probe', title: 'Probe item', contexts: ['page'] }])
        check('the extension created a page context-menu item', created.ok, JSON.stringify(created))

        const view: Page = await navigateToFixture(app, `${started.origin}/orivon-fixture/`, 'granted-page-fixture')
        await liveApp.evaluate(() => { (globalThis as MenuHolder).__orivonLastMenu = undefined })
        await view.click('body', { button: 'right' })
        const shown = await waitFor(async () => await liveApp.evaluate(() => (globalThis as MenuHolder).__orivonLastMenu !== undefined))
        const labels = shown ? await liveApp.evaluate(() => ((globalThis as MenuHolder).__orivonLastMenu?.items ?? []).map((item) => item.label)) : []
        check('right-clicking the granted page opened a menu', shown)
        check('the menu holds the extension\'s item', labels.includes('Probe item'), JSON.stringify(labels))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  }, TEST_TIMEOUT_MS)

  it('[app:extensions-reach-a-site-that-holds-permissions] chrome.tabCapture captures the granted page\'s tab once the extension is invoked on it', async () => {
    const started = await startServer()

    await runPhase('extensions on a granted page: tab capture', async (check) => {
      let app: ElectronApplication | undefined
      try {
        let extensionId = ''
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER, '--autoplay-policy=no-user-gesture-required'],
          seedProfile: async (dir) => { extensionId = seedFixture(dir, 'offscreen-capture') },
          sandbox: true
        })
        const liveApp = app
        check('the fixture extension is loaded', await waitFor(async () => (await liveApp.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1))
        check('the developer-only grant hook is installed and the origin is granted', await grantOrigin(app, started.origin))

        const view = await navigateToFixture(app, `${started.origin}/orivon-fixture/audio`, 'granted-audio-fixture')
        const chrome = findChrome(app)
        check('the granted tab\'s oscillator is running', await waitFor(async () => await evaluateRetrying(view, () => (window as unknown as { __ctx?: AudioContext }).__ctx?.state === 'running'), 8_000))
        const tabId = await liveApp.evaluate(({ webContents }, url: string) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.id ?? -2, `${started.origin}/orivon-fixture/audio`)

        // The first worker of a new extension misses the library's preload and is reloaded once: the first message waits for it.
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        const selector = `#${extensionId}`
        check('the toolbar shows the fixture\'s action', await waitFor(async () => await chrome.evaluate(
          (sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, selector
        ), 5_000))
        await chrome.click(selector)
        const popupOpened = await waitFor(() => liveApp.windows().some((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`)), 8_000)
        check('clicking the action opens the popup over the granted page', popupOpened)
        const popup = liveApp.windows().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`))

        let captured: { ok: boolean, streamId?: string, offscreenResult?: { ok: boolean, trackReadyState?: string } } | undefined
        if (popup !== undefined) {
          await popup.click('#capture')
          await waitFor(async () => (await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')).length > 0, 8_000)
          const text = await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')
          captured = text.length > 0 ? JSON.parse(text) as typeof captured : undefined
        }
        check('tabCapture.getMediaStreamId gave the extension a stream id for the granted tab', typeof captured?.streamId === 'string', JSON.stringify({ captured, tabId, output: mainOutput(liveApp).slice(-400) }))
        check('the offscreen document\'s getUserMedia("tab") call returns a live track', captured?.offscreenResult?.trackReadyState === 'live', JSON.stringify(captured))
        check('the granted tab is muted locally while captured', await liveApp.evaluate(({ webContents }, id: number) => webContents.fromId(id)?.audioMuted, tabId) === true)
        check('no refusal about a granted app reached the log', !mainOutput(liveApp).includes('belongs to a granted app'))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  }, TEST_TIMEOUT_MS)
})
