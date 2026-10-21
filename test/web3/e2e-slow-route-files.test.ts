// A page whose files arrive late or fail for a moment still loads whole, and one that stays broken says so.
//
//  - On the serve path a stylesheet the gateway fails for longer than one block fetch is retried is read again before the
//    page is answered an error, so the page is styled and nothing marks it.
//  - A stylesheet that stays failed leaves the page unstyled, and the address bar says some files did not load; the mark
//    reloads the page, which then loads whole and the mark goes.
//  - Over a slow route (a website in the tunnel profile, whose requests ride a SOCKS5 fixture) a stylesheet the gateway
//    holds back for longer than a direct connection would wait still styles the page.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-slow-route-files.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { evaluateRetrying, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const STYLED = 'rgb(18, 52, 86)'
const page = (title: string, sheet: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/${sheet}"><body>${title}</body>`
const SITE = {
  'retried.html': page('retried fixture', 'retried.css'),
  'broken.html': page('broken fixture', 'broken.css'),
  'slow.html': page('slow fixture', 'slow.css'),
  'retried.css': 'body{background:#123456}',
  'broken.css': 'body{background:#123456}',
  'slow.css': 'body{background:#123456}'
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function launched (extra: { env?: Record<string, string>, args?: string[], seed?: (dir: string) => void } = {}) {
  const gateway = await startFixtureGateway({ site: SITE })
  cleanups.push(async () => { await gateway.close() })
  const port = new URL(gateway.url).port
  const { app, chrome } = await launchShell({
    env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'slow.eth': `ipfs://${gateway.roots['site']}` }), ORIVON_TEST_IPFS_GATEWAYS: `http://gw.slow.test:${port}`, ...extra.env },
    args: [`--host-resolver-rules=MAP gw.slow.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, ...(extra.args ?? [])],
    seedProfile: async (userDataDir: string) => { extra.seed?.(userDataDir) }
  })
  cleanups.push(async () => { await app.close().catch(() => {}) })
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  return { app, chrome, gateway, port }
}

const background = async (view: Page): Promise<string> => await evaluateRetrying(view, () => getComputedStyle(document.body).backgroundColor)
const chipShown = async (chrome: Page): Promise<boolean> => await chrome.evaluate(() => { const chip = document.querySelector<HTMLElement>('#files-chip'); return chip !== null && !chip.hidden })

async function open (app: ElectronApplication, chrome: Page, path: string, title: string): Promise<Page> {
  const url = `https://slow.eth/${path}`
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { title }, 120_000)).ok, `${path} loaded`).toBe(true)
  const view = findViewShowing(app, chrome, url)
  if (view === undefined) throw new Error(`no view shows ${url}`)
  return view
}

it('[app:serve-retries-a-file-before-it-fails] a stylesheet the gateway fails for longer than one block fetch retries is read again, the page is styled, and nothing marks it', async () => {
  const { app, chrome, gateway } = await launched()
  gateway.failNext('site', 'retried.css', 502, 4)
  const view = await open(app, chrome, 'retried.html', 'retried fixture')
  expect(await waitFor(async () => await background(view) === STYLED, 120_000), 'the stylesheet arrived after the gateway recovered').toBe(true)
  expect(await chipShown(chrome), 'a page that loaded whole carries no mark').toBe(false)
  expect(gateway.requests.filter((request) => request.includes(gateway.blockOf('site', 'retried.css')))).not.toHaveLength(1)
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:page-says-files-did-not-load] a stylesheet that stays failed leaves the page unstyled and marked, and the mark reloads it whole', async () => {
  const { app, chrome, gateway } = await launched()
  gateway.failNext('site', 'broken.css', 502, 1_000)
  const view = await open(app, chrome, 'broken.html', 'broken fixture')
  expect(await waitFor(async () => await chipShown(chrome), 240_000), 'the address bar says some files did not load').toBe(true)
  expect(await background(view)).not.toBe(STYLED)
  await shoot(app, chrome, chrome, 'files-chip')

  gateway.failNext('site', 'broken.css', 502, 0)
  await chrome.click('#files-chip')
  const reloaded = findViewShowing(app, chrome, 'https://slow.eth/broken.html') as Page
  expect(await waitFor(async () => await background(reloaded) === STYLED, 120_000), 'the reload read the stylesheet').toBe(true)
  expect(await waitFor(async () => !await chipShown(chrome), 20_000), 'the mark went with the missing file').toBe(true)
}, 10 * QA_TEST_TIMEOUT_MS)

it('[app:slow-route-waits-for-bytes] over a slow route a stylesheet held back longer than a direct connection would wait still styles the page', async () => {
  // The gateway name is reachable only through the tunnel; a decoy on the same port on loopback is a fetch that skipped it.
  const real = await startFixtureGateway({ site: SITE })
  cleanups.push(async () => { await real.close() })
  const decoy = await startFixtureGateway({ site: SITE })
  cleanups.push(async () => { await decoy.close() })
  const decoyPort = new URL(decoy.url).port
  const tunnel = await startSocks5Fixture({ preferAuth: true, names: { [`gw.slow.test:${decoyPort}`]: { host: '127.0.0.1', port: Number(new URL(real.url).port) } } })
  cleanups.push(async () => { await tunnel.close() })
  const { app, chrome } = await launchShell({
    env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'slow.eth': `ipfs://${real.roots['site']}` }), ORIVON_TEST_IPFS_GATEWAYS: `http://gw.slow.test:${decoyPort}` },
    args: ['--host-resolver-rules=MAP gw.slow.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    seedProfile: async (userDataDir: string) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(tunnel.port)}` } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: ['https://slow.eth'], off: [], apart: ['https://slow.eth'], apartDirect: [] }))
    }
  })
  cleanups.push(async () => { await app.close().catch(() => {}) })
  expect(await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)).toBe(true)

  // A direct connection gives a block 30 s; this one is held 40 s, and then arrives.
  real.delayNext('site', 'slow.css', 40_000, 10)
  const began = Date.now()
  const view = await open(app, chrome, 'slow.html', 'slow fixture')
  expect(await waitFor(async () => await background(view) === STYLED, 150_000), 'the stylesheet that took 40 s styled the page').toBe(true)
  expect(Date.now() - began, 'and it really was held back').toBeGreaterThanOrEqual(38_000)
  expect(await chipShown(chrome), 'and nothing says a file failed').toBe(false)
  expect(tunnel.requests.some((request) => request.destination === 'gw.slow.test'), 'the gateway was asked through the tunnel').toBe(true)
  expect(decoy.requests.filter((request) => request.endsWith('?format=raw')), 'and never around it').toEqual([])
}, 12 * QA_TEST_TIMEOUT_MS)
