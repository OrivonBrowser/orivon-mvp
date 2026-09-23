// An OIDC login's round trip, in a real shell: the app keeps its state in
// sessionStorage, sends the tab to a sign-in provider, and reads the state
// back when the provider returns the tab. The app holds a grant, so the tab
// changes session on the way out and again on the way back. sessionStorage
// lives in a view, which no unit test's fake has, so only a real launch shows
// whether the tab came back to the view holding it.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, mismatch, waitFor, waitForTab } from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase,
  waitForAddressBarStable
} from './e2e-helpers.js'
import { originFromUrl } from '../src/broker/policy/origin.js'
import { partitionFor } from '../src/broker/grants/origin-hash.js'
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

function page (title: string, script: string): string {
  return `<!doctype html><title>${title}</title><script>${script}</script>`
}

afterAll(async () => {
  await Promise.all([appServer, providerServer].map(async (s) => {
    if (s !== undefined) await new Promise<void>((resolve) => { s.close(() => { resolve() }) })
  }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const WAIT_BUDGET_MS = 8_000 + ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + 12_000 + 8_000 + APP_CLOSE_RACE_MS
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 20_000

it('an app finds its sessionStorage where it left it when a sign-in provider sends the tab back', async () => {
  let providerOrigin = ''
  appServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    if (req.url === '/start') {
      // A sign-in button the test really clicks: Chromium's back button skips
      // a page that navigated away without the person's activation.
      res.end(`<!doctype html><title>start</title><button id="login">Sign in</button><script>
        sessionStorage.setItem('oidc', 'state-123')
        document.getElementById('login').onclick = () => { location.href = '${providerOrigin}/authorize' }
      </script>`)
    } else {
      res.end(page('callback', "document.title = 'callback:' + (sessionStorage.getItem('oidc') ?? 'missing')"))
    }
  })
  const appOrigin = await listen(appServer)
  const callbackUrl = `${appOrigin}/callback?code=abc`
  providerServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page('authorize', `setTimeout(() => { location.href = '${callbackUrl}' }, ${String(PROVIDER_DELAY_MS)})`))
  })
  providerOrigin = await listen(providerServer)

  await runPhase('the app reads its sessionStorage after the provider returns the tab', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const ready = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', ready)

      // Only the app is granted: a grant is what isolates it (ADR-0018), and
      // the provider must stay on the default session for the tab to move.
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

      const seen = await app.evaluate(({ webContents, session }, args: { callbackUrl: string, partition: string, appOrigin: string, providerOrigin: string }) => {
        const all = webContents.getAllWebContents()
        const tab = all.find((c) => c.getURL() === args.callbackUrl)
        if (tab === undefined) return undefined
        return {
          inAppSession: tab.session === session.fromPartition(args.partition),
          history: tab.navigationHistory.getAllEntries().map((entry) => entry.url),
          canGoBack: tab.navigationHistory.canGoBack(),
          providerViews: all.filter((c) => c.getURL().startsWith(args.providerOrigin)).length
        }
      }, { callbackUrl, partition: partitionFor(originFromUrl(appOrigin) as string), appOrigin, providerOrigin })

      check('the callback page is findable in the main process', seen !== undefined)
      if (seen === undefined) return
      check("the tab is back in the app's own session", seen.inAppSession, JSON.stringify(seen))
      check("the app's history holds only its own pages, the start page among them",
        seen.canGoBack && seen.history.every((url) => url.startsWith(appOrigin)) && seen.history.includes(`${appOrigin}/start`),
        JSON.stringify(seen))
      check("no view is left on the provider's page", seen.providerViews === 0, JSON.stringify(seen))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
