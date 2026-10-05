// An OIDC login's round trip, in a real shell: the app keeps its state in
// sessionStorage, sends the tab to a sign-in provider, and reads the state
// back when the provider returns the tab. The app holds a grant but is
// delivered from the network, so it runs in the shared default session
// throughout (ADR-0044), same as the provider -- but the tab's VIEW still
// swaps away and back, since ADR-0017's fetch()-routing flag is fixed at
// WebContentsView construction and differs between a registered app and an
// unregistered provider. sessionStorage lives in a view, which no unit
// test's fake has, so only a real launch shows whether the tab comes back to
// a view that still holds it (tab-view.ts's parkKeyFor).
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, mismatch, waitFor, waitForTab } from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase,
  waitForAddressBarStable
} from './e2e-helpers.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.session-storage-fixture',
  name: 'Session-storage fixture',
  version: '0.1.0',
  entry: 'index.html',
  capabilities: {}
}

/** Long enough that the provider's page, which first commits in the app's
 * session before the tab moves, is gone before it could navigate itself. */
const PROVIDER_DELAY_MS = 500

let appServer: Server | undefined
let providerServer: Server | undefined

async function listen (server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}`
}

// External, never inline: the granted app origin below sends no CSP header
// of its own, so Orivon's own appended one (no 'unsafe-inline' in
// script-src) is the only policy in force, and an inline <script> would not
// run under it.
function page (title: string, scriptSrc: string): string {
  return `<!doctype html><title>${title}</title><script src="${scriptSrc}"></script>`
}

afterAll(async () => {
  await Promise.all([appServer, providerServer].map(async (s) => {
    if (s !== undefined) await new Promise<void>((resolve) => { s.close(() => { resolve() }) })
  }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const WAIT_BUDGET_MS = 8_000 + ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + 12_000 + 8_000 + APP_CLOSE_RACE_MS
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 20_000

it('[app:sessionstorage-survives-cross-origin-return] an app finds its sessionStorage where it left it when a sign-in provider sends the tab back', async () => {
  let providerOrigin = ''
  appServer = createServer((req, res) => {
    if (req.url === '/start.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      // A sign-in button the test really clicks: Chromium's back button skips
      // a page that navigated away without the person's activation.
      res.end(`
        sessionStorage.setItem('oidc', 'state-123')
        document.getElementById('login').onclick = () => { location.href = '${providerOrigin}/authorize' }
      `)
      return
    }
    if (req.url === '/callback.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end("document.title = 'callback:' + (sessionStorage.getItem('oidc') ?? 'missing')")
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    if (req.url === '/start') {
      res.end(`<!doctype html><title>start</title><button id="login">Sign in</button><script src="start.js"></script>`)
    } else {
      res.end(page('callback', 'callback.js'))
    }
  })
  const appOrigin = await listen(appServer)
  const callbackUrl = `${appOrigin}/callback?code=abc`
  providerServer = createServer((req, res) => {
    if (req.url === '/authorize.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(`setTimeout(() => { location.href = '${callbackUrl}' }, ${String(PROVIDER_DELAY_MS)})`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page('authorize', 'authorize.js'))
  })
  providerOrigin = await listen(providerServer)

  await runPhase('the app reads its sessionStorage after the provider returns the tab', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const ready = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', ready)

      // Only the app is granted; the provider never is. Under ADR-0044 that
      // no longer isolates the app into its own partition -- both run in
      // the shared default session -- so this exercises the flag-only view
      // swap (ADR-0017), not a session swap.
      const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return false
        await hook(request)
        return true
      }, { origin: appOrigin, manifest: FIXTURE_MANIFEST, capability: 'id', patterns: [] } satisfies DevGrantRequest)
      check('the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)', granted)
      if (!granted) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `${appOrigin}/start`)
      const started = await waitForTab(chrome, { address: `${appOrigin}/start`, title: 'start' })
      check('the app\'s start page loads', started.ok, mismatch({ title: 'start' }, started.info))
      const startPage = app.windows().find((w) => w.url() === `${appOrigin}/start`)
      check('the start page is reachable to click', startPage !== undefined)
      await startPage?.click('#login')

      const expected = { address: callbackUrl, title: 'callback:state-123' }
      const landed = await waitForTab(chrome, expected)
      check('the callback page reads the state the start page left in sessionStorage', landed.ok, mismatch(expected, landed.info))

      const seen = await app.evaluate(({ webContents, session }, args: { callbackUrl: string, appOrigin: string, providerOrigin: string }) => {
        const all = webContents.getAllWebContents()
        const tab = all.find((c) => c.getURL() === args.callbackUrl)
        if (tab === undefined) return undefined
        return {
          inDefaultSession: tab.session === session.defaultSession,
          history: tab.navigationHistory.getAllEntries().map((entry) => entry.url),
          canGoBack: tab.navigationHistory.canGoBack(),
          providerViews: all.filter((c) => c.getURL().startsWith(args.providerOrigin)).length
        }
      }, { callbackUrl, appOrigin, providerOrigin })

      check('the callback page is findable in the main process', seen !== undefined)
      if (seen === undefined) return
      // ADR-0044: a granted, network-served app has no partition of its own
      // any more -- it shares the default session with the provider it just
      // visited, same as every other site.
      check("the tab is in the shared default session", seen.inDefaultSession, JSON.stringify(seen))
      check("the app's history holds only its own pages, the start page among them",
        seen.canGoBack && seen.history.every((url) => url.startsWith(appOrigin)) && seen.history.includes(`${appOrigin}/start`),
        JSON.stringify(seen))
      check("no view is left on the provider's page", seen.providerViews === 0, JSON.stringify(seen))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
