// What the person sees and what the browser keeps while Nym is the tunnel and a tunnel is slow, fails, or carries nothing.
// The Nym module is the stand-in that e2e-app-routed-nym uses (nym-stand-in.ts), told by a file what to get wrong.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-nym-tunnel-health.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { Server as TcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAME = 'health.nym.test'

interface FakeConfig {
  readonly failStart?: boolean
  readonly failFirstSetups?: number
  readonly startDelayMs?: number
  readonly silentDnsTunnels?: number
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function launched (fake: FakeConfig, everywhere: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-nym-health-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  // A server for the Settings test's own destination, and one for the page.
  const echo: TcpServer = createTcpServer((socket) => { socket.on('error', () => {}); socket.end() })
  await new Promise<void>((resolve) => { echo.listen(0, '127.0.0.1', resolve) })
  const web = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>tunnelled</title><body>tunnelled</body>') })
  await new Promise<void>((resolve) => { web.listen(0, '127.0.0.1', resolve) })
  const webPort = (web.address() as AddressInfo).port
  cleanups.push(async () => {
    await new Promise<void>((resolve) => { echo.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { web.close(() => { resolve() }); web.closeAllConnections() })
  })
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ ...fake, log: logFile, targets: { 'example.com:443': { host: '127.0.0.1', port: (echo.address() as AddressInfo).port }, [`${NAME}:${String(webPort)}`]: { host: '127.0.0.1', port: webPort } } }))
  const { app, chrome } = await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.tunnel.everywhere': everywhere } })) }
  })
  cleanups.push(async () => { await app.close().catch(() => {}) })
  const log = (): string[] => readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '')
  const settings = async (): Promise<Page> => {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await page.waitForSelector('.route-test button')
    return page
  }
  return { app, chrome, log, settings, url: `http://${NAME}:${String(webPort)}/` }
}

const buttonText = async (page: Page): Promise<string> => (await page.locator('.route-test button').first().textContent()) ?? ''
const beside = async (page: Page): Promise<string> => (await page.locator('.route-test span').first().textContent().catch(() => '')) ?? ''

it('[app:nym-settings-test-answers] the Settings test says it is testing and that it can take a while, then answers, and the tunnel it opened is closed within seconds of the answer', async () => {
  const world = await launched({ startDelayMs: 4_000 }, false)
  const page = await world.settings()
  await page.locator('.route-test button').first().click()
  expect(await waitFor(async () => (await buttonText(page)) === 'Testing…', 3_000), 'the button says it is testing at once').toBe(true)
  expect(await beside(page), 'and the person is told it can take a while').toMatch(/up to a minute/)
  expect(await waitFor(async () => (await beside(page)).startsWith('Nym answered'), 30_000), `the answer came: ${await beside(page)}`).toBe(true)
  expect(await buttonText(page)).toBe('Test')
  expect(await waitFor(() => world.log().some((line) => line.startsWith('down ')), 20_000), `the test's own tunnel was closed: ${world.log().join('|')}`).toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:nym-settings-test-answers] a tunnel that cannot come up is said so, with the reason, in the answer', async () => {
  const failing = await launched({ failStart: true }, false)
  const page = await failing.settings()
  await page.locator('.route-test button').first().click()
  expect(await waitFor(async () => (await beside(page)).includes('did not work'), 30_000), `an answer came: ${await beside(page)}`).toBe(true)
  expect(await beside(page), 'with the reason').toContain('the stand-in gateway is unreachable')
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:nym-tunnel-tries-another-gateway] a tunnel whose first gateway fails comes up through the next, and the Settings test answers as if nothing had happened', async () => {
  const world = await launched({ failFirstSetups: 1 }, false)
  const page = await world.settings()
  await page.locator('.route-test button').first().click()
  expect(await waitFor(async () => (await beside(page)).startsWith('Nym answered'), 40_000), `the answer came: ${await beside(page)}`).toBe(true)
  expect(world.log().filter((line) => line.startsWith('up ')).length, 'one tunnel came up').toBe(1)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:nym-dead-tunnel-is-replaced] with the whole browser on the tunnel, a Nym tunnel that answers no name is closed after a few stalls, and the next load arrives through a new one', async () => {
  const world = await launched({ silentDnsTunnels: 1 }, true)
  // Two loads of the name in a row: each is a lookup nobody answers, and the second is the stall that closes the tunnel.
  await clickAddressBarRetrying(world.chrome, world.url)
  await delay(1_000)
  await clickAddressBarRetrying(world.chrome, world.url)
  expect(await waitFor(() => world.log().filter((line) => line.startsWith('down ')).length >= 1, 60_000), `the tunnel that carried nothing was closed: ${world.log().join('|')}`).toBe(true)
  await delay(500)
  await clickAddressBarRetrying(world.chrome, world.url)
  expect((await waitForTab(world.chrome, { address: world.url, title: 'tunnelled' }, 60_000)).ok, `the page arrived through the new tunnel: ${world.log().join('|')}`).toBe(true)
  expect(world.log().filter((line) => line.startsWith('up ')).length, 'a second tunnel came up').toBeGreaterThanOrEqual(2)
}, 6 * QA_TEST_TIMEOUT_MS)
