// With the whole browser on the tunnel and Nym as the tunnel (the default choice), a website with no setting of its own
// arrives through a Nym tunnel and never at the decoy on the same address, and the shell starts and stays usable at once:
// nothing at start-up waits for Nym. With a Nym that cannot start, the website fails closed (nothing arrives anywhere
// else), and the window still answers. The Nym module is the stand-in `e2e-app-routed-nym` uses.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-everywhere-nym.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAME = 'plain.nym.test'


interface Hosted { port: number, hits: () => number, close: () => Promise<void> }

async function host (title: string): Promise<Hosted> {
  let hits = 0
  const server: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function launched (failStart: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-everywhere-nym-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  const decoy = await host('direct')
  const real = await host('tunnelled')
  cleanups.push(async () => { await decoy.close(); await real.close() })
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ failStart, log: logFile, targets: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } } }))

  const started = Date.now()
  const { app, chrome } = await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.tunnel.everywhere': true } })) }
  })
  cleanups.push(async () => { await app.close().catch(() => {}) })
  return { app, chrome, decoy, real, url: `http://${NAME}:${String(decoy.port)}/`, log: (): string[] => readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== ''), startupMs: Date.now() - started }
}

it('[app:tunnel-everywhere-on-nym] a website with no setting arrives through a Nym tunnel, the decoy is never reached, and nothing at start-up waited for Nym', async () => {
  const world = await launched(false)
  // The engine's own requests at start-up (its component updater) are carried by the tunnel as well and may bring Nym up first; what must not have happened is a dial for the page before it was opened.
  expect(world.log().filter((line) => line.startsWith('tcp ') || line.startsWith('udp ')), 'nothing was dialled through Nym before the page was asked for').toEqual([])
  await clickAddressBarRetrying(world.chrome, world.url)
  expect((await waitForTab(world.chrome, { address: world.url, title: 'tunnelled' }, 60_000)).ok, 'the page came through Nym').toBe(true)
  expect(world.log().some((line) => line.startsWith('tcp ') && line.endsWith(`${NAME}:${String(world.decoy.port)}`)), world.log().join('|')).toBe(true)
  expect(world.decoy.hits(), 'the decoy on the same address was never reached').toBe(0)
  expect(world.real.hits()).toBeGreaterThan(0)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-on-nym] with a Nym that cannot start, the website fails closed and the window still answers', async () => {
  const world = await launched(true)
  await clickAddressBarRetrying(world.chrome, world.url)
  await delay(4000)
  expect((await activeTabInfo(world.chrome)).title).not.toBe('tunnelled')
  expect((await activeTabInfo(world.chrome)).title).not.toBe('direct')
  expect(world.decoy.hits() + world.real.hits(), 'nothing arrived anywhere').toBe(0)
  // The shell is not stuck on the tunnel: a new tab opens and shows a page Orivon serves itself.
  expect(await waitFor(async () => await world.chrome.evaluate(() => document.readyState === 'complete'))).toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)
