// A website at an onion address (`.onion`) that the person sends through their own proxy: the name reaches the SOCKS5
// server unresolved, the only way a Tor client can carry it, and the page loads. Chromium resolves no `.onion` name itself
// (RFC 7686), so a route that resolved or refused the name here would leave such a site unreachable. The SOCKS5 fixture
// stands in for Tor: it maps the onion name to a page on loopback and records what it was asked for. An onion name typed
// with no scheme opens over http, on port 80, even with "Always use secure connections" on: an onion service serves
// plain http, and Tor encrypts the connection end to end.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-onion-through-own-proxy.test.ts
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
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { waitForTab } from '../support/smoke-helpers.mjs'

/** A well-formed v3 onion name (56 base32 characters) that exists nowhere but in the fixture. */
const ONION = 'orivonexampleonionaddresssentunresolvedtotheproxyxxxxxxx.onion'
const SITE = `http://${ONION}`
/** A second name for the address typed with no scheme, so the proxy's record of it cannot come from the first test. */
const BARE_ONION = 'orivonexampleonionaddresstypedwithnoschemexxxxxxxxxx.onion'
const BARE_SITE = `http://${BARE_ONION}`
const TITLE = 'through-the-onion'
const BARE_TITLE = 'typed-without-a-scheme'

let dir: string
let app: ElectronApplication
let chrome: Page
let socks: Socks5Fixture
let page: Server

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-onion-proxy-e2e-'))
  page = createServer((request, response) => {
    const title = request.headers.host?.startsWith(BARE_ONION) === true ? BARE_TITLE : TITLE
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`)
  })
  await new Promise<void>((resolve) => { page.listen(0, '127.0.0.1', resolve) })
  const port = (page.address() as AddressInfo).port
  socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true, names: { [`${ONION}:80`]: { host: '127.0.0.1', port }, [`${BARE_ONION}:80`]: { host: '127.0.0.1', port } } })
  const launched = await launchShell({
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'privacy.httpsOnly': true } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [SITE, BARE_SITE], via: { [SITE]: 'socks5', [BARE_SITE]: 'socks5' }, off: [], apart: [], apartProxy: [], apartDirect: [] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  await socks?.close()
  await new Promise<void>((resolve) => { page?.close(() => { resolve() }) })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:onion-site-through-own-proxy] an onion address sent through the person\'s own proxy loads, its name reaching the SOCKS5 server unresolved', async () => {
  await clickAddressBarRetrying(chrome, `${SITE}/`)
  expect((await waitForTab(chrome, { address: `${SITE}/`, title: TITLE }, 60_000)).ok, 'the onion page loaded through the proxy').toBe(true)
  const asked = socks.requests.filter((request) => request.destination === ONION)
  expect(asked.length, JSON.stringify(socks.requests)).toBeGreaterThan(0)
  expect(asked.every((request) => request.addressType === 'domain' && request.port === 80), 'the name itself, on the port the address names').toBe(true)
  expect(socks.requests.every((request) => request.addressType === 'domain'), 'no address was resolved in its place').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:onion-address-typed-without-a-scheme] an onion address typed with no scheme opens over http on port 80 and loads through the person\'s own proxy', async () => {
  await clickAddressBarRetrying(chrome, BARE_ONION.toUpperCase())
  expect((await waitForTab(chrome, { address: `${BARE_SITE}/`, title: BARE_TITLE }, 60_000)).ok, 'the bare name opened as an http address and loaded').toBe(true)
  const asked = socks.requests.filter((request) => request.destination === BARE_ONION)
  expect(asked.length, JSON.stringify(socks.requests)).toBeGreaterThan(0)
  expect(asked.every((request) => request.addressType === 'domain' && request.port === 80), 'the name itself, on port 80 and never 443').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)
