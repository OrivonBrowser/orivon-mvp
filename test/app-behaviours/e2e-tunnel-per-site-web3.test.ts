// Two `.eth` websites in one browser, one on Nym and one on the person's own proxy: the verifier host reads each from its
// gateway through that site's tunnel alone. The gateway name is the same for both, and each tunnel (the Nym stand-in and the
// SOCKS5 fixture) maps it to a gateway of its own, so the gateway that was asked says which tunnel carried the read. A decoy
// on the name's own address would show a direct read; it is never asked.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-per-site-web3.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, waitFor } from '../support/smoke-helpers.mjs'

const GATEWAY = 'gw.pair.test'
const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>eth fixture</title><body>eth fixture</body>' }

let dir: string
let socks: Socks5Fixture
let viaNym: Awaited<ReturnType<typeof startFixtureGateway>>
let viaProxy: Awaited<ReturnType<typeof startFixtureGateway>>
let decoy: Awaited<ReturnType<typeof startFixtureGateway>>
let app: ElectronApplication
let chrome: Page

const blocksAsked = (gateway: typeof viaNym): number => gateway.requests.filter((request) => request.endsWith('?format=raw')).length

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-per-site-web3-e2e-'))
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  decoy = await startFixtureGateway({ tunnelled: SITE })
  viaNym = await startFixtureGateway({ tunnelled: SITE })
  viaProxy = await startFixtureGateway({ tunnelled: SITE })
  const decoyPort = new URL(decoy.url).port
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ log: logFile, targets: { [`${GATEWAY}:${decoyPort}`]: { host: '127.0.0.1', port: Number(new URL(viaNym.url).port) } } }))
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${GATEWAY}:${decoyPort}`]: { host: '127.0.0.1', port: Number(new URL(viaProxy.url).port) } } })
  const launched = await launchShell({
    env: {
      ORIVON_TEST_NYM_MODULE: moduleDir,
      ORIVON_TEST_NYM_FAKE: configFile,
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'nymsite.eth': `ipfs://${viaNym.roots['tunnelled']}`, 'proxysite.eth': `ipfs://${viaNym.roots['tunnelled']}` }),
      ORIVON_TEST_IPFS_GATEWAYS: `http://${GATEWAY}:${decoyPort}`,
      ORIVON_TEST_DOH: `http://${GATEWAY}:${decoyPort}/dns-query`
    },
    args: [`--host-resolver-rules=MAP ${GATEWAY} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir: string) => {
      // Nym is the choice for what has none of its own; the proxy address is saved beside it.
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: ['https://nymsite.eth', 'https://proxysite.eth'], via: { 'https://proxysite.eth': 'socks5' }, off: [], apart: [], apartProxy: [], apartDirect: [] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await decoy.close()
  await viaNym.close()
  await viaProxy.close()
  await socks.close()
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:tunnel-per-site] a .eth name on Nym and a .eth name on the proxy are each read through their own tunnel and never directly', async () => {
  await navigateToFixture(app, 'https://nymsite.eth/', 'eth fixture')
  expect(blocksAsked(viaNym), 'the Nym site was read through Nym').toBeGreaterThan(0)
  expect(blocksAsked(viaProxy), 'and not through the proxy').toBe(0)

  await navigateToFixture(app, 'https://proxysite.eth/', 'eth fixture')
  expect(blocksAsked(viaProxy), 'the proxy site was read through the proxy').toBeGreaterThan(0)
  expect(socks.requests.find((request) => request.destination === GATEWAY)?.userId, 'signed in to the proxy with credentials of its own').toBeDefined()

  await delay(1000)
  expect(blocksAsked(decoy), 'neither was ever read directly').toBe(0)
}, 4 * QA_TEST_TIMEOUT_MS)
