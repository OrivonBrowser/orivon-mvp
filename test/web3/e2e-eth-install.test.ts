// A `.eth` app installs through the ordinary path, hint to consent to pin,
// and its pin records the CID every file was verified against. This is the
// one install journey a hermetic run can drive for real: a loopback fixture
// origin is refused by the install-origin guard (A46), but a `.eth` origin
// is served by the verifier, so its host has no address to refuse.
//
// Driven through the test seam: `app.eth` maps to a root the fixture gateway
// built, with no light client and no mainnet. Once installed, the app is
// served from its pin inside its own partition, so it still opens after the
// gateway is gone.
import { afterAll, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { originHash } from '../../src/broker/grants/origin-hash.js'
import { BUILTIN_ADDRESSES } from '../../src/protocols/builtin.js'
import { answerEveryQuestion, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'

const ORIGIN = 'https://app.eth'
const SHOWN = BUILTIN_ADDRESSES.displayUrl(`${ORIGIN}/`)
const MANIFEST = { orivonApiVersion: 0, id: 'eth.orivon.fixture', name: 'Eth fixture', version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: {} }
const APP = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>eth app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>eth app<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify(MANIFEST)
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 3 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('installs a .eth app from verified IPFS content, pins its CID, and opens it from cache with the gateway gone', async () => {
  await runPhase('eth-install', async (check) => {
    const gateway = await startFixtureGateway({ app: APP })
    let gatewayClosed = false
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const root = gateway.roots['app']!
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'app.eth': `ipfs://${root}` }), ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      await stubNativeDialogs(running)
      // The fixture declares nothing to ask about; should it ever, the question is answered in the panel.
      answerEveryQuestion(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const pinFile = join(userData, 'apps', originHash(ORIGIN), 'pin.json')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
      const loaded = await waitForTab(chrome, { address: SHOWN, title: 'eth app' })
      check('app.eth loaded from the gateway', loaded.ok)

      const pinned = await waitFor(() => existsSync(pinFile), 25_000)
      check('the hint installed it: a pin exists for https://app.eth', pinned)
      if (!pinned) throw new Error(`no pin at ${pinFile}`)
      const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as { content?: { cid: string, via: string, pointersVerified: boolean }, assets: Array<{ path: string }> }
      check(`the pin records the CID every file was verified against (${JSON.stringify(pin.content)})`, pin.content?.cid === root && pin.content.via === 'ipfs' && pin.content.pointersVerified)
      check('the pin covers the manifest, the entry and its script', ['/.well-known/orivon.json', '/index.html', '/app.js'].every((path) => pin.assets.some((asset) => asset.path === path)))
      // The loader's requests come from no page, so the verifier gives them the name's own partition,
      // the one the tab used: installing asks the gateway for the root no second time.
      const rootAsks = gateway.requests.filter((request) => request.includes(root)).length
      check(`the install reused the tab's verified mount (${String(rootAsks)} request for the root)`, rootAsks === 1)

      await gateway.close()
      gatewayClosed = true
      await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
      const reopened = await waitForTab(chrome, { address: SHOWN, title: 'eth app' })
      // The tab already showed this address and title before the reload, and installing swaps
      // its view, so poll the newest page at that address until the script's mark is there. Read
      // from main: Playwright does not always attach to a view swapped in this late.
      let ran: string | null = null
      await waitFor(async () => {
        ran = await running.evaluate(async ({ webContents }, url) => {
          const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === url).sort((a, b) => b.id - a.id)[0]
          return newest === undefined ? null : await newest.executeJavaScript('document.body.dataset.app ?? null') as string | null
        }, `${ORIGIN}/`).catch(() => null)
        return ran === 'ran'
      }, 10_000)
      check(`with the gateway gone, it opens from its pin and its script runs (${String(ran)})`, reopened.ok && ran === 'ran')

      expect(await noNativeDialogs(running)).toEqual([])
      expect(pin.content).toEqual({ cid: root, via: 'ipfs', pointersVerified: true })
      expect(ran).toBe('ran')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (!gatewayClosed) await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
