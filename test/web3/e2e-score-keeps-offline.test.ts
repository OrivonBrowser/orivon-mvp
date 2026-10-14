// A loaded .eth site keeps the Website level it earned when Orivon can no longer look: the gateways and the Web3 Score
// provider go dark and the verifier host forgets every mount (what ten idle minutes, a restart or a tunnel switch do),
// and the shield and mark still read Level 4, Web3, with the Web3 Score page saying the last check is what it shows.
// A file that fails its check still drops the level at once. Driven through the test seam, so no light client and no
// mainnet; the provider is a plain static server whose files Orivon asks for again after a second.
import { afterAll, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { bucketFile, bucketOf, listen, readScore } from './score-provider-support.js'

const PROVIDER_NAME = 'Offline e2e provider'
const FILES_KEPT_MS = 1_000
const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>kept fixture</title><body>kept<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"'
}
const TAMPERED = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>tampered fixture</title><body>tampered<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran" // tampered'
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 3 + DEFAULT_ACTION_TIMEOUT_MS * 14 + APP_CLOSE_RACE_MS + 90_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The shield asks again whenever the active tab changes: leave the site for a new tab and come back to the first. */
async function askAgain (chrome: ReturnType<typeof findChrome>): Promise<void> {
  await chrome.click('#new-tab')
  await waitFor(async () => await chrome.evaluate(() => document.querySelector('#web3-score-btn .web3-shield')?.hasAttribute('data-level') === false), 5_000)
  await chrome.locator('.tab').first().click()
}

it('a loaded .eth site keeps its judged Level 4 while the gateways, the provider and the verifier mounts are gone, and a tampered file still drops it', async () => {
  await runPhase('score-keeps-offline', async (check) => {
    // A gateway that served a tampered block is dropped for the session, so the tampered site has a gateway of its own.
    const gateway = await startFixtureGateway({ kept: SITE })
    const liar = await startFixtureGateway({ tampered: TAMPERED })
    liar.tamper('tampered', 'app.js')
    const id = `cid:${gateway.roots['kept']!}`
    const asked: string[] = []
    const files = new Map<string, string>([
      ['/score/provider.json', JSON.stringify({ standard: 'orivon-web3-score/1', name: PROVIDER_NAME, bucketHexChars: 2 })],
      [`/score/website/${bucketOf(id)}.json`, bucketFile(id, 4)]
    ])
    const provider: { server: Server, port: number } = await listen((req, res) => {
      asked.push(req.url ?? '')
      const body = files.get(req.url ?? '')
      if (body === undefined) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
    const address = `http://127.0.0.1:${String(provider.port)}/score`
    let providerClosed = false
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_DEV_ORIGINS: '1',
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'kept.eth': `ipfs://${gateway.roots['kept']!}`, 'tampered.eth': `ipfs://${liar.roots['tampered']!}` }),
          ORIVON_TEST_IPFS_GATEWAYS: `${gateway.url},${liar.url}`,
          ORIVON_TEST_SCORE_ANSWER_KEPT_MS: String(FILES_KEPT_MS)
        },
        seedProfile: async (dir: string) => {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'web3.scoreProvider': address } }))
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      const view = await navigateToFixture(app, 'https://tampered.eth/', 'tampered fixture')
      // The refusal of the script is what the verifier reports; the shield reads it when it next asks.
      const refused = await waitFor(async () => await view.evaluate(async () => await fetch('/app.js').then((r) => r.status, () => 0)) !== 200, 30_000)
      check('the tampered script is refused', refused)
      const chrome = findChrome(app)
      await askAgain(chrome)
      const tampered = await readScore(app, '1')
      check(`a site with a tampered file is Level 1, marked "Web2" (${tampered.level}/${tampered.mark})`, tampered.level === '1' && tampered.mark === 'Web2')

      await navigateToFixture(app, 'https://kept.eth/', 'kept fixture')
      const judged = await readScore(app, '4')
      check(`the provider's Level 4 shows: "Web3" (${judged.level}/${judged.mark})`, judged.level === '4' && judged.mark === 'Web3')
      check(`it names the provider (${judged.label})`, judged.label === `Website level 4 (Web3), judged by ${PROVIDER_NAME}`)
      check('nothing says the check is old while the site can be looked at', !judged.text.includes('could not be checked again just now'))

      // Everything Orivon would look at is gone: the provider, the gateway, and the verifier's mounts.
      await new Promise<void>((resolve) => { provider.server.closeAllConnections(); provider.server.close(() => { resolve() }) })
      providerClosed = true
      await gateway.close()
      await running.evaluate(() => { (globalThis as { __orivonDevEthFixtures?: { idle?: () => void } }).__orivonDevEthFixtures?.idle?.() })
      await chrome.waitForTimeout(FILES_KEPT_MS + 500)
      await askAgain(chrome)
      const offline = await readScore(app, '4')
      check(`offline, the shield still paints Level 4, marked "Web3" (${offline.level}/${offline.mark})`, offline.level === '4' && offline.mark === 'Web3')
      check(`the label still names the provider (${offline.label})`, offline.label === `Website level 4 (Web3), judged by ${PROVIDER_NAME}`)
      check(`the Web3 Score page still leads with Website level 4 (${offline.heading})`, offline.heading === 'Website level 4')
      check('it says the last check is what it shows', offline.text.includes('It could not be checked again just now, so this is the last check.'))

      expect([tampered.level, judged.level, offline.level, offline.mark]).toEqual(['1', '4', '4', 'Web3'])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (!providerClosed) await new Promise<void>((resolve) => { provider.server.close(() => { resolve() }) })
      await gateway.close().catch(() => {})
      await liar.close()
    }
  })
}, TEST_TIMEOUT_MS)
