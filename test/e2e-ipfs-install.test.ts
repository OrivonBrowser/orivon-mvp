// An app served from a typed `ipfs://<cid>` address installs through the
// ordinary manifest-hint path and reaches the install consent prompt. The
// page runs at `https://<cid>.ipfs.orivon`, so that is the origin the pin is
// keyed by. Driven through the test seam's gateway, so nothing leaves the
// machine.
import { afterAll, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'
import { originHash } from '../src/broker/grants/origin-hash.js'

const MANIFEST = { orivonApiVersion: 0, id: 'ipfs.orivon.fixture', name: 'Ipfs fixture', version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } }
const APP = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>ipfs app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>ipfs app<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify(MANIFEST)
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('installs an app served from a typed ipfs:// address, pins its CID, and asks for consent', async () => {
  await runPhase('ipfs-install', async (check) => {
    const gateway = await startFixtureGateway({ app: APP })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const root = gateway.roots['app']!
      const origin = `https://${root}.ipfs.orivon`
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      await running.evaluate(({ dialog }) => {
        const globals = globalThis as unknown as { __promptCount?: number }
        globals.__promptCount = 0
        dialog.showMessageBox = (async () => {
          globals.__promptCount = (globals.__promptCount ?? 0) + 1
          return { response: 0, checkboxChecked: false }
        }) as unknown as typeof dialog.showMessageBox
      })
      const listening = await waitFor(async () => await running.evaluate(() => (globalThis as { __orivonDevEthFixtures?: { listening: boolean } }).__orivonDevEthFixtures?.listening === true), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const pinFile = join(userData, 'apps', originHash(origin), 'pin.json')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      const loaded = await waitForTab(chrome, { address: `ipfs://${root}/`, title: 'ipfs app' })
      check(`the typed ipfs:// address loaded (${JSON.stringify(loaded.info)})`, loaded.ok)

      const pinned = await waitFor(() => existsSync(pinFile), 25_000)
      check(`the hint installed it: a pin exists for ${origin}`, pinned)
      const pin = pinned ? JSON.parse(readFileSync(pinFile, 'utf8')) as { content?: { cid: string } } : {}
      check(`the pin records the root CID (${JSON.stringify(pin.content)})`, pin.content?.cid === root)
      // The pin lands before the consent step runs, so the prompt is polled for, never read once.
      const readPrompts = async (): Promise<number> => await running.evaluate(() => (globalThis as unknown as { __promptCount?: number }).__promptCount ?? 0)
      await waitFor(async () => (await readPrompts()) >= 1, 10_000)
      const prompts = await readPrompts()
      check(`the install consent prompt was shown (${String(prompts)})`, prompts >= 1)

      expect(loaded.ok).toBe(true)
      expect(pinned).toBe(true)
      expect(pin.content?.cid).toBe(root)
      expect(prompts).toBeGreaterThanOrEqual(1)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
