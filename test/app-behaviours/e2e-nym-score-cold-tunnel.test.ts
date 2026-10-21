// The Web3 Score shield for a page opened right after the whole browser was put on the tunnel, while the Nym tunnel is
// still coming up: the lookup waits for the tunnel and the score is shown once Nym answers, and a provider that truly
// cannot be reached is said so in the shield's label instead of "no score yet". The Nym module is the stand-in
// `e2e-app-routed-nym` uses (nym-stand-in.ts); the provider is a loopback server only the tunnel's name reaches.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-nym-score-cold-tunnel.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { navigateToFixture } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, waitFor } from '../support/smoke-helpers.mjs'
import { bucketFile, bucketOf, startSite } from '../web3/score-provider-support.js'

const PROVIDER = 'score.nym.test'
const SCORED = 'sha256:' + '1a'.repeat(32)
const PROVIDER_NAME = 'Cold tunnel provider'
/** The first gateway never answers and the host gives up on it after 30 seconds: a cold tunnel that takes longer than a provider fetch's ordinary 30 s, as a real one can (up to 95 s). */
const COLD_TUNNEL_MS = 40_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function listen (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server, port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, port: (server.address() as AddressInfo).port }
}

async function launched (fake: object) {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-nym-score-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  const files = new Map<string, string>([
    ['/score/provider.json', JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 })],
    [`/score/website/${bucketOf(SCORED)}.json`, bucketFile(SCORED, 3)]
  ])
  let directHits = 0
  // What the provider does to the next requests: `failFirst` answers a 503, and `holdMs` holds each answer back, as a provider behind a slow route does.
  const behaviour = { failFirst: 0, holdMs: 0 }
  const real = await listen((request, response) => {
    if (behaviour.failFirst > 0) {
      behaviour.failFirst -= 1
      response.writeHead(503).end()
      return
    }
    const body = files.get(request.url ?? '')
    const answer = (): void => {
      if (body === undefined) response.writeHead(404).end()
      else response.writeHead(200, { 'content-type': 'application/json' }).end(body)
    }
    if (behaviour.holdMs > 0) setTimeout(answer, behaviour.holdMs)
    else answer()
  })
  // The same name and port on loopback, which only a fetch that skipped the tunnel would reach.
  const decoy = await listen((_request, response) => { directHits += 1; response.writeHead(404).end() })
  const scored = await startSite('scored fixture', SCORED)
  cleanups.push(async () => { for (const each of [real.server, decoy.server, scored.server]) await new Promise<void>((resolve) => { each.close(() => { resolve() }); each.closeAllConnections() }) })
  const configFile = join(dir, 'fake.json')
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  writeFileSync(configFile, JSON.stringify({ ...fake, log: logFile, targets: { [`${PROVIDER}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } } }))
  const { app, chrome } = await launchShell({
    env: { ORIVON_DEV_ORIGINS: '1', ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: [`--host-resolver-rules=MAP ${PROVIDER} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.tunnel.everywhere': false, 'web3.scoreProvider': `http://${PROVIDER}:${String(decoy.port)}/score` } })) }
  })
  cleanups.push(async () => { await app.close().catch(() => {}) })
  return { app, chrome, behaviour, scoredUrl: `http://127.0.0.1:${String(scored.port)}/`, directHits: () => directHits }
}

/** Switches the whole browser onto the tunnel in Settings, as a person does. */
async function putBrowserOnTunnel (world: Awaited<ReturnType<typeof launched>>): Promise<void> {
  await world.chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
  expect(await waitFor(() => world.app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const settings = world.app.windows().find((w) => w.url().startsWith('orivon://settings'))!
  await settings.waitForSelector('#row-route-everywhere input[type=checkbox]')
  await settings.locator('#row-route-everywhere input[type=checkbox]').click()
  await delay(300)
  await settings.close()
}

const shield = async (world: Awaited<ReturnType<typeof launched>>): Promise<{ level: string, label: string }> => await world.chrome.evaluate(() => {
  const button = document.querySelector('#web3-score-btn')
  return { level: button?.querySelector('.web3-shield')?.getAttribute('data-level') ?? '', label: button?.getAttribute('aria-label') ?? '' }
})

it('[app:score-waits-for-a-cold-tunnel] the first scored page opened right after the browser went onto a tunnel that takes longer than a normal fetch shows its judged level once Nym answers', async () => {
  const world = await launched({ hangFirstSetups: 1 })
  await putBrowserOnTunnel(world)
  await navigateToFixture(world.app, world.scoredUrl, 'scored fixture')

  expect(await waitFor(async () => (await shield(world)).level === '2', 15_000), 'the observed level shows while the provider is asked').toBe(true)
  expect(await waitFor(async () => (await shield(world)).level === '3', COLD_TUNNEL_MS + 40_000), 'the judged level is shown once the tunnel carries the lookup').toBe(true)
  expect((await shield(world)).label).toContain(`judged by ${PROVIDER_NAME}`)
  expect(world.directHits(), 'the provider was never asked around the tunnel').toBe(0)
}, COLD_TUNNEL_MS + 6 * QA_TEST_TIMEOUT_MS)

it('[app:score-says-when-the-provider-cannot-be-reached] with a Nym that cannot start, the shield says the provider could not be reached instead of "no score yet"', async () => {
  const world = await launched({ failStart: true })
  await putBrowserOnTunnel(world)
  await navigateToFixture(world.app, world.scoredUrl, 'scored fixture')

  // The lookup asks a few times, a slow route's pause apart, before it gives up: the label comes after that, not at the first failure.
  expect(await waitFor(async () => (await shield(world)).label.includes('could not be reached'), 420_000), (await shield(world)).label).toBe(true)
  expect((await shield(world)).level).toBe('2')
  expect((await shield(world)).label).not.toContain('no Web3 Score for this site yet')
  expect(world.directHits(), 'nothing was asked around the tunnel').toBe(0)
}, 10 * QA_TEST_TIMEOUT_MS)

it('[app:score-patient-on-slow-route] a provider that fails once and then answers later than a direct connection would wait keeps the shield checking, and the judged level is shown without it ever saying the provider could not be reached', async () => {
  const world = await launched({})
  world.behaviour.failFirst = 1
  world.behaviour.holdMs = 32_000
  await putBrowserOnTunnel(world)
  await navigateToFixture(world.app, world.scoredUrl, 'scored fixture')

  let saidUnreachable = false
  const shown = await waitFor(async () => {
    const now = await shield(world)
    if (now.label.includes('could not be reached')) saidUnreachable = true
    return now.level === '3'
  }, 240_000)
  expect(saidUnreachable, 'while the lookup was still progressing the shield never said the provider could not be reached').toBe(false)
  expect(shown, 'the judged level is shown once the slow provider answers').toBe(true)
  expect((await shield(world)).label).toContain(`judged by ${PROVIDER_NAME}`)
  expect(world.directHits(), 'the provider was never asked around the tunnel').toBe(0)
}, 20 * QA_TEST_TIMEOUT_MS)
