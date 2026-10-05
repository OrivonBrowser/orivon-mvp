// Serves an MV2 extension's chrome.webRequest listeners from real requests.
// Fixture: test/apps/extensions/webrequest-mv2/ (blocking onBeforeRequest,
// onBeforeSendHeaders and onHeadersReceived listeners, plus observers that
// log what they see on their own background page). Seeded the real way
// (test/e2e-extensions-dnr.test.ts's own doc): registry.json plus
// loadableManifest's stripped copy, which keeps webRequest and
// webRequestBlocking out of the loaded manifest.
//
// Run with `npm run test:e2e`, or build and drive it through
// scripts/run-headless.mjs with this file as the only spec.
import { afterAll, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './support/e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/webrequest-mv2/', import.meta.url)).replace(/[/\\]$/, '')

function seedWebRequestExtension (userDataDir: string): InstalledExtension {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`webrequest-mv2 fixture's own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const slot = 'webrequest-mv2'
  const key = resolveSlotKey(userDataDir, slot)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  const entry: InstalledExtension = {
    id: generateId(key),
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: FIXTURE_DIR },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
  return entry
}

const PAGE_HTML = `<!doctype html>
<title>webrequest-fixture</title>
<body>
<script src="/wr-ads/x.js" onerror="window.__adBlocked = true"></script>
<script src="/wr-redirect" onload="window.__redirectLoaded = true"></script>
<iframe src="/wr-frame"></iframe>
<script>
window.__pageRan = true
fetch('/wr-echo').then((r) => r.text().then((body) => { window.__echo = { body, response: r.headers.get('x-wr-response') } })).catch((e) => { window.__echoError = String(e) })
</script>
</body>`

// The extension's addListener calls reach the main process over IPC after its background page has run them, so
// this page asks for a URL the extension cancels until one is refused: from then on its listeners are in force.
const WARMUP_HTML = `<!doctype html>
<title>webrequest-warmup</title>
<script>
(async () => {
  for (let n = 0; n < 200; n++) {
    try { await fetch('/wr-ads/ping?' + n) } catch { window.__wrActive = true; return }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})()
</script>`

interface Seen { readonly url: string, readonly headers: IncomingHttpHeaders }

function startFixtureServer (seen: Seen[]): Promise<{ server: Server, origin: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    seen.push({ url, headers: req.headers })
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGE_HTML)
    } else if (url === '/warmup') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(WARMUP_HTML)
    } else if (url.startsWith('/wr-ads/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__adRan = true;')
    } else if (url.startsWith('/wr-redirect')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__notRedirected = true;')
    } else if (url.startsWith('/wr-frame')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>frame</title><p>frame</p>')
    } else if (url.startsWith('/wr-echo')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(String(req.headers['x-wr-test'] ?? 'missing'))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('webrequest fixture server did not report a port'))
        return
      }
      resolve({ server, origin: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

interface LogEntry {
  readonly event: string
  readonly url: string
  readonly type: string
  readonly tabId: number
  readonly frameId: number
  readonly parentFrameId: number
  readonly initiator?: string
  readonly statusCode?: number
  readonly error?: string
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

it('serves an MV2 extension\'s blocking and observing webRequest listeners from real requests', async () => {
  const seen: Seen[] = []
  const started = await startFixtureServer(seen)
  server = started.server
  const fixtureUrl = `${started.origin}/`

  await runPhase('extensions webRequest', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      let extensionId = ''
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedWebRequestExtension(dir).id },
        sandbox: true
      })
      const liveApp = app

      // The background page registers its listeners as it loads; a request made before it has is not seen,
      // so the request waits for the flag the page sets after its last addListener call.
      const backgroundReady = await waitFor(async () => await liveApp.evaluate(async ({ webContents }, id: string) => {
        const background = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(`chrome-extension://${id}/`))
        return await background?.executeJavaScript('window.__wrReady === true').catch(() => false) === true
      }, extensionId), 20_000)
      check('the extension\'s background page loaded', backgroundReady)

      const warmup = await navigateToFixture(app, `${started.origin}/warmup`, 'webrequest-warmup')
      const active = await waitFor(async () => await evaluateRetrying(warmup, () => (window as unknown as { __wrActive?: boolean }).__wrActive === true), 20_000).catch(() => false)
      check('the extension\'s listeners came into force (a /wr-ads/ request was refused)', active)
      seen.splice(0)

      const view = await navigateToFixture(app, fixtureUrl, 'webrequest-fixture')
      const pageRan = await waitFor(async () => await evaluateRetrying(view, () => Boolean((window as unknown as { __pageRan?: boolean }).__pageRan)))
      check('the fixture page\'s own script ran', pageRan)

      const flag = async (name: string): Promise<boolean> => await view.evaluate((n: string) => Boolean((window as unknown as Record<string, unknown>)[n]), name)

      // ---- blocking onBeforeRequest: cancel ----
      const adBlocked = await waitFor(async () => await flag('__adBlocked')).catch(() => false)
      check('onBeforeRequest cancelled /wr-ads/x.js (its onerror fired)', adBlocked)
      check('the cancelled script never ran', !(await flag('__adRan')))
      check('the cancelled request never reached the server', !seen.some((entry) => entry.url.startsWith('/wr-ads/x.js')))

      // ---- blocking onBeforeRequest: redirect to the extension's own web-accessible resource ----
      const redirected = await waitFor(async () => await flag('__redirected')).catch(() => false)
      check('onBeforeRequest redirected /wr-redirect to the extension\'s web-accessible script, which ran', redirected,
        JSON.stringify({ loaded: await flag('__redirectLoaded'), notRedirected: await flag('__notRedirected') }))

      // ---- blocking onBeforeSendHeaders and onHeadersReceived ----
      const echo = await waitFor(async () => (await evaluateRetrying(view, () => (window as unknown as { __echo?: unknown }).__echo)) !== undefined)
        .then(async () => await evaluateRetrying(view, () => (window as unknown as { __echo?: { body: string, response: string | null } }).__echo))
        .catch(() => undefined)
      check('onBeforeSendHeaders added x-wr-test, which the server received', echo?.body === '1', JSON.stringify(echo))
      check('the server saw the header on the request itself', seen.some((entry) => entry.url.startsWith('/wr-echo') && entry.headers['x-wr-test'] === '1'))
      check('onHeadersReceived added x-wr-response, which the page read', echo?.response === '1', JSON.stringify(echo))

      // ---- observers ----
      const tabId = await liveApp.evaluate(({ webContents }, url: string) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.id ?? -2, fixtureUrl)
      const readLog = async (): Promise<LogEntry[]> => await liveApp.evaluate(async ({ webContents }, id: string) => {
        const background = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(`chrome-extension://${id}/`))
        return JSON.parse(await background?.executeJavaScript('JSON.stringify(window.__wrLog)') ?? '[]') as LogEntry[]
      }, extensionId)
      const seenAll = await waitFor(async () => {
        const log = await readLog()
        return ['onSendHeaders', 'onResponseStarted', 'onCompleted', 'onErrorOccurred'].every((event) => log.some((entry) => entry.event === event))
      }).catch(() => false)
      const log = await readLog()
      check('onSendHeaders, onResponseStarted, onCompleted and onErrorOccurred were all observed', seenAll, JSON.stringify(log.map((entry) => entry.event)))

      const adError = log.find((entry) => entry.event === 'onErrorOccurred' && entry.url.includes('/wr-ads/x.js'))
      check('onErrorOccurred reported the cancelled request as blocked by the client', adError?.error?.includes('ERR_BLOCKED_BY_CLIENT') === true, JSON.stringify(adError))
      const echoDone = log.find((entry) => entry.event === 'onCompleted' && entry.url.includes('/wr-echo'))
      check('onCompleted reported /wr-echo with status 200, type xmlhttprequest and the tab\'s id', echoDone?.statusCode === 200 && echoDone.type === 'xmlhttprequest' && echoDone.tabId === tabId, JSON.stringify({ echoDone, tabId }))
      check('the page\'s document load reported as main_frame with no initiator', log.some((entry) => entry.event === 'onCompleted' && entry.type === 'main_frame' && entry.url === fixtureUrl && entry.initiator === undefined && entry.parentFrameId === -1 && entry.frameId === 0), JSON.stringify(log.filter((entry) => entry.type === 'main_frame')))
      const frame = log.find((entry) => entry.event === 'onCompleted' && entry.url.endsWith('/wr-frame'))
      check('the iframe reported as sub_frame with its own frame id and the page as parent', frame?.type === 'sub_frame' && frame.frameId > 0 && frame.parentFrameId === 0 && frame.initiator === started.origin, JSON.stringify(frame))
      check('every request the page made was reported against the page\'s tab', log.filter((entry) => entry.url.startsWith(started.origin)).every((entry) => entry.tabId === tabId), JSON.stringify(log.map((entry) => [entry.url, entry.tabId])))

      // ---- a request with no page is invisible to the extension ----
      const before = (await readLog()).length
      const mainProcessFetch = await liveApp.evaluate(async ({ net }, url: string) => {
        try {
          const response = await net.fetch(url)
          return { ok: response.ok, status: response.status }
        } catch (error) {
          return { ok: false, status: 0, error: String(error) }
        }
      }, `${started.origin}/wr-ads/main.js`)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      check('a main-process net.fetch to a URL the extension cancels is untouched', mainProcessFetch.ok && mainProcessFetch.status === 200, JSON.stringify(mainProcessFetch))
      check('and the extension\'s observers never saw it', (await readLog()).length === before)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
