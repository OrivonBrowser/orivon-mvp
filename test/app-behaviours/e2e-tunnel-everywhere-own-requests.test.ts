// With the whole browser on the tunnel, what Orivon itself fetches arrives through it too: the verifier host's gateway
// fetch for a `.eth` name (the host is pointed at the shared front and signs in to it with `net.request`) and a Web3
// Score lookup about a page. Each name has a decoy on the same port on loopback, so a fetch that skipped the tunnel
// would land on a decoy and count a hit. The `.eth` site is then shown as fully tunnelled, not in part.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-everywhere-own-requests.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { shoot } from '../support/auth-support.js'
import { navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { bucketFile, bucketOf, readScore, startSite } from '../web3/score-provider-support.js'

const GATEWAY = 'gw.socks.test'
const PROVIDER = 'score.socks.test'
const SCORED = 'sha256:' + '1a'.repeat(32)
const PROVIDER_NAME = 'Tunnelled provider'
const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>eth fixture</title><body>eth fixture</body>' }

interface Counted { server: Server, port: number, hits: () => number }

async function counted (answer: (url: string) => { status: number, body: string } = () => ({ status: 404, body: '' })): Promise<Counted> {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    const { status, body } = answer(req.url ?? '')
    res.writeHead(status, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, port: (server.address() as AddressInfo).port, hits: () => hits }
}

let dir: string
let socks: Socks5Fixture
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>
let gatewayDecoy: Counted
let providerDecoy: Counted
let providerReal: Counted
let scored: Awaited<ReturnType<typeof startSite>>
let app: ElectronApplication
let chrome: Page
const cleanups: Array<() => Promise<void> | void> = []

const requestsTo = (name: string): number => socks.requests.filter((request) => request.destination === name).length
const closeServer = (server: Server) => async (): Promise<void> => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-everywhere-own-e2e-'))
  gateway = await startFixtureGateway({ tunnelled: SITE })
  gatewayDecoy = await counted()
  providerDecoy = await counted()
  providerReal = await counted((url) => {
    const files = new Map<string, string>([
      ['/score/provider.json', JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 })],
      [`/score/website/${bucketOf(SCORED)}.json`, bucketFile(SCORED, 3)]
    ])
    const body = files.get(url)
    return body === undefined ? { status: 404, body: '' } : { status: 200, body }
  })
  scored = await startSite('scored fixture', SCORED)
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: {
      [`${GATEWAY}:${String(gatewayDecoy.port)}`]: { host: '127.0.0.1', port: Number(new URL(gateway.url).port) },
      [`${PROVIDER}:${String(providerDecoy.port)}`]: { host: '127.0.0.1', port: providerReal.port }
    }
  })
  cleanups.push(
    closeServer(gatewayDecoy.server), closeServer(providerDecoy.server), closeServer(providerReal.server), closeServer(scored.server),
    async () => { await gateway.close() },
    async () => { await socks.close() },
    () => { rmSync(dir, { recursive: true, force: true }) }
  )

  const launched = await launchShell({
    env: {
      ORIVON_DEV_ORIGINS: '1',
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'tunnelled.eth': `ipfs://${gateway.roots['tunnelled']}` }),
      ORIVON_TEST_IPFS_GATEWAYS: `http://${GATEWAY}:${String(gatewayDecoy.port)}`
    },
    args: [`--host-resolver-rules=MAP ${GATEWAY} 127.0.0.1, MAP ${PROVIDER} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
        version: 1,
        values: {
          'network.route.proxy': `127.0.0.1:${String(socks.port)}`,
          'network.tunnel.everywhere': true,
          'web3.scoreProvider': `http://${PROVIDER}:${String(providerDecoy.port)}/score`
        }
      }))
    }
  })
  app = launched.app
  chrome = launched.chrome
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:tunnel-everywhere-carries-orivons-own-requests] the verifier host fetches a .eth name\'s files from the gateway through the tunnel, and the site is shown as fully tunnelled', async () => {
  await navigateToFixture(app, 'https://tunnelled.eth/', 'eth fixture')

  expect(requestsTo(GATEWAY), 'the verifier host asked the gateway through the tunnel').toBeGreaterThan(0)
  expect(gatewayDecoy.hits(), 'and never directly').toBe(0)
  expect(socks.requests.find((request) => request.destination === GATEWAY)?.userId, 'it signed in to the tunnel').toBeDefined()
  expect(socks.requests.map((request) => request.destination).filter((name) => name.endsWith('.eth')), 'the name itself never went to the tunnel').toEqual([])

  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on'), 'the tunnel button is purple').toBe(true)
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('true')
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-state').textContent(), 'the popover says the whole browser goes through it, and not that any part stays outside').toBe('This browser\'s traffic goes through your tunnel.')
  await popover.click('#tunnel-tab-first')
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-state').textContent(), 'the site\'s own panel says the same of the site').toBe('This site\'s traffic goes through your tunnel.')
  await shoot(app, chrome, popover, 'tunnel-everywhere-web3')
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-carries-orivons-own-requests] a Web3 Score lookup about a page goes to the provider through the tunnel', async () => {
  await chrome.click('#tunnel-btn').catch(() => {})
  await navigateToFixture(app, `http://127.0.0.1:${String(scored.port)}/`, 'scored fixture')

  const judged = await readScore(app, '3')
  expect(judged.level, 'the provider judged the page').toBe('3')
  expect(judged.text).toContain(PROVIDER_NAME)
  expect(requestsTo(PROVIDER), 'the lookup went through the tunnel').toBeGreaterThan(0)
  expect(providerDecoy.hits(), 'and never directly').toBe(0)
}, 4 * QA_TEST_TIMEOUT_MS)
