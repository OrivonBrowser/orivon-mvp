// Two websites in one browser, each with the tunnel it picked: one goes through Nym and the other through the person's own
// proxy, at the same time. Each arrives only at its own tunnel (the Nym stand-in's log and the SOCKS5 fixture's requests each
// name only their own site), neither ever reaches the decoy on the same address, and each lives in the profile of its tunnel.
// The routes file names the tunnel of each site (`via`), as a person's picks are saved.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-per-site.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { waitForTab } from '../support/smoke-helpers.mjs'

const NYM_SITE = 'site.nym.test'
const PROXY_SITE = 'site.proxy.test'

interface Hosted { port: number, hits: () => number, close: () => Promise<void> }

async function host (title: string): Promise<Hosted> {
  let hits = 0
  const server: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

let dir: string
let app: ElectronApplication
let chrome: Page
let socks: Socks5Fixture
let logFile: string
let decoyNym: Hosted
let decoyProxy: Hosted
let realNym: Hosted
let realProxy: Hosted
const cleanups: Array<() => Promise<void> | void> = []

const urlOf = (name: string, port: number): string => `http://${name}:${String(port)}/`
const nymLog = (): string[] => readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-per-site-e2e-'))
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  decoyNym = await host('direct-nym')
  decoyProxy = await host('direct-proxy')
  realNym = await host('through-nym')
  realProxy = await host('through-proxy')
  logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ log: logFile, targets: { [`${NYM_SITE}:${String(decoyNym.port)}`]: { host: '127.0.0.1', port: realNym.port } } }))
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${PROXY_SITE}:${String(decoyProxy.port)}`]: { host: '127.0.0.1', port: realProxy.port } } })
  cleanups.push(async () => { await decoyNym.close(); await decoyProxy.close(); await realNym.close(); await realProxy.close(); await socks.close() }, () => { rmSync(dir, { recursive: true, force: true }) })

  const launched = await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: [`--host-resolver-rules=MAP ${NYM_SITE} 127.0.0.1, MAP ${PROXY_SITE} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      // Nym is the choice for everything with none of its own; the proxy address is saved beside it.
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      const nym = urlOf(NYM_SITE, decoyNym.port).replace(/\/$/, '')
      const proxy = urlOf(PROXY_SITE, decoyProxy.port).replace(/\/$/, '')
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [nym, proxy], via: { [proxy]: 'socks5' }, off: [], apart: [], apartProxy: [], apartDirect: [] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const sessionName = async (address: string): Promise<string | null> => await app.evaluate(({ webContents, session }, url) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
  if (contents === undefined) return null
  for (const name of ['tunnel-profile-memory', 'proxy-profile-memory', 'direct-profile-memory']) if (contents.session === session.fromPartition(name)) return name
  return contents.session === session.defaultSession ? 'default' : 'other'
}, address)

it('[app:tunnel-per-site] a site on Nym and a site on the proxy each arrive through their own tunnel and nowhere else', async () => {
  const nymUrl = urlOf(NYM_SITE, decoyNym.port)
  const proxyUrl = urlOf(PROXY_SITE, decoyProxy.port)

  await clickAddressBarRetrying(chrome, nymUrl)
  expect((await waitForTab(chrome, { address: nymUrl, title: 'through-nym' }, 60_000)).ok, 'the Nym site came through Nym').toBe(true)
  const nymSession = await sessionName(nymUrl)
  await clickAddressBarRetrying(chrome, proxyUrl)
  expect((await waitForTab(chrome, { address: proxyUrl, title: 'through-proxy' }, 60_000)).ok, 'the proxy site came through the proxy').toBe(true)
  const proxySession = await sessionName(proxyUrl)

  expect(nymLog().some((line) => line.startsWith('tcp ') && line.endsWith(`${NYM_SITE}:${String(decoyNym.port)}`)), nymLog().join('|')).toBe(true)
  expect(nymLog().some((line) => line.includes(PROXY_SITE)), 'the proxy site never went through Nym').toBe(false)
  expect(socks.requests.some((request) => request.destination === PROXY_SITE), 'the proxy site went through the proxy').toBe(true)
  expect(socks.requests.some((request) => request.destination === NYM_SITE), 'the Nym site never went through the proxy').toBe(false)
  expect(decoyNym.hits() + decoyProxy.hits(), 'neither went direct').toBe(0)
  expect(nymSession, 'the Nym site lives in Nym\'s profile').toBe('tunnel-profile-memory')
  expect(proxySession, 'the proxy site lives in the proxy\'s profile').toBe('proxy-profile-memory')
}, 4 * QA_TEST_TIMEOUT_MS)
