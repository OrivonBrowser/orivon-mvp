// A `.eth` name served through the verifier: its content comes from IPFS,
// every block checked against its CID, over the loopback TLS server the
// shell trusts only by the run's certificate fingerprint. Driven through
// the test seam, so no light client and no mainnet: `fixture.eth` maps
// straight to a root the fixture gateway built.
//
// The last phase is a canary. Electron 44 does not enforce Chromium's Local
// Network Access, so today every page can reach loopback. A `.eth` page is
// itself served from loopback, and would be exempt from those checks once
// they are enforced unless its address space is overridden. The phase
// asserts the `.eth` page and a page marked public get the same answer
// from a loopback service; if an upgrade starts enforcing the checks, the
// two diverge and this fails. docs/open-questions.md tracks the gap.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'

const HOST = '127.0.0.1'
const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"'
}
const SCRIPTED = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>scripted fixture</title><body>scripted<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran" // scripted'
}
const BROKEN = { 'index.html': '<!doctype html><meta charset="utf-8"><title>tampered fixture</title><body>tampered</body>' }

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What a page gets from fetching `target`, under a deadline, since evaluate() has none of its own. */
async function fetchFrom (view: { evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R> }, target: string): Promise<string> {
  const attempt = view.evaluate(async (url: string) => {
    try {
      const response = await fetch(url)
      return `status ${String(response.status)}: ${await response.text()}`
    } catch (error) {
      return `refused: ${String(error)}`
    }
  }, target)
  return await Promise.race([attempt, new Promise<string>((resolve) => setTimeout(() => { resolve('no answer within 10 s') }, 10_000))])
}

async function listen (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server, port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, HOST, resolve) })
  return { server, port: (server.address() as AddressInfo).port }
}

it('loads a .eth name from verified IPFS content, refuses a tampered block, and grants the page no loopback privilege', async () => {
  await runPhase('eth-verified', async (check) => {
    // Two gateways, each the only source of its sites: the one that lies about
    // script.eth is dropped for the session, and broken.eth's refusal must
    // still come from its own tampered block, on the other.
    const gateway = await startFixtureGateway({ site: SITE, script: SCRIPTED })
    const brokenGateway = await startFixtureGateway({ broken: BROKEN })
    const loopback = await listen((_req, res) => { res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }).end('loopback service') })
    const publicPage = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>public page</title><body>public</body>') })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      brokenGateway.tamper('broken', 'index.html')
      gateway.tamper('script', 'app.js')
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER, `--ip-address-space-overrides=${HOST}:${String(publicPage.port)}=public`],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'fixture.eth': `ipfs://${gateway.roots['site']!}`, 'broken.eth': `ipfs://${brokenGateway.roots['broken']!}`, 'script.eth': `ipfs://${gateway.roots['script']!}` }),
          ORIVON_TEST_IPFS_GATEWAYS: `${gateway.url},${brokenGateway.url}`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => (globalThis as { __orivonDevEthFixtures?: { listening: boolean } }).__orivonDevEthFixtures?.listening === true), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      const view = await navigateToFixture(app, 'https://fixture.eth/', 'verified fixture')
      const page = await evaluateRetrying(view, () => ({ secure: window.isSecureContext, subtle: typeof crypto.subtle, ran: document.body.dataset['app'] ?? null }))
      check(`fixture.eth loaded from the gateway and is a secure context (${JSON.stringify(page)})`, page.secure && page.subtle === 'object')
      check('its script ran', page.ran === 'ran')
      check(`the gateway was asked for raw blocks (${String(gateway.requests.length)} requests)`, gateway.requests.some((r) => r.endsWith('?format=raw')))

      const fromEth = await fetchFrom(view, `http://${HOST}:${String(loopback.port)}/`)
      const publicView = await navigateToFixture(app, `http://${HOST}:${String(publicPage.port)}/`, 'public page')
      const fromPublic = await fetchFrom(publicView, `http://${HOST}:${String(loopback.port)}/`)
      check(`a .eth page reaches a loopback service exactly as a public page does (.eth: ${fromEth}; public: ${fromPublic})`, fromEth === fromPublic)

      const scripted = await navigateToFixture(app, 'https://script.eth/', 'scripted fixture')
      const tamperedScript = await evaluateRetrying(scripted, async () => ({ ran: document.body.dataset['app'] ?? null, fetched: await fetch('/app.js').then((r) => r.status, () => 0) }))
      check(`a script whose block was tampered is refused: it never ran, and fetching it fails (${JSON.stringify(tamperedScript)})`, tamperedScript.ran === null && tamperedScript.fetched !== 200)

      const brokenView = await navigateToFixture(app, 'https://broken.eth/', 'Cannot verify this site')
      const brokenPage = await evaluateRetrying(brokenView, () => document.body.innerText)
      const brokenBlock = brokenGateway.blockOf('broken', 'index.html')
      check(`a page whose own block was tampered shows the error page naming that block, and nothing of it (${brokenPage.replace(/\s+/g, ' ').slice(0, 300)})`, brokenPage.includes(brokenBlock) && !brokenPage.includes('tampered fixture'))

      expect(page).toEqual({ secure: true, subtle: 'object', ran: 'ran' })
      expect(tamperedScript.ran).toBeNull()
      expect(fromEth).toBe(fromPublic)
      expect(brokenPage).toContain(brokenBlock)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      await brokenGateway.close()
      loopback.server.close()
      publicPage.server.close()
    }
  })
}, TEST_TIMEOUT_MS)
