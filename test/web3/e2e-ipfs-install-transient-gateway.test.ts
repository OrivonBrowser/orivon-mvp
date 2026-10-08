// A gateway that answers a 5xx for some of an app's files, briefly, does not
// abort the install: the verifier asks again and the loader fetches again,
// and the install reaches its consent question. One file fails once (the
// verifier's second pass serves it); another fails for every pass of one
// verifier fetch, so the verifier answers the loader 502 and the loader's
// own retry serves it. Driven through the test seam's gateway, so nothing
// leaves the machine.
import { afterAll, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { originHash } from '../../src/broker/grants/origin-hash.js'
import { answerAccepting, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import type { QuestionText } from '../support/question-support.js'

const MANIFEST = { orivonApiVersion: 0, id: 'ipfs.orivon.transient', name: 'Ipfs transient fixture', version: '1.0.0', entry: 'index.html', assets: ['app.js', 'style.css'], capabilities: { fs: { quotaBytes: 1_048_576 } } }
const APP = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>transient app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>transient app<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"',
  'style.css': 'body { margin: 0 }',
  '.well-known/orivon.json': JSON.stringify(MANIFEST)
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:transient-gateway-error-does-not-abort-an-install] installs an app whose files meet a gateway 502, pins its CID, and asks for consent', async () => {
  await runPhase('ipfs-install-transient-gateway', async (check) => {
    const gateway = await startFixtureGateway({ app: APP })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const root = gateway.roots['app']!
      gateway.failNext('app', 'app.js', 502, 1)
      gateway.failNext('app', 'style.css', 502, 3)
      const origin = `https://${root}.ipfs.orivon`
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const pinFile = join(userData, 'apps', originHash(origin), 'pin.json')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      const loaded = await waitForTab(chrome, { address: `ipfs://${root}/`, title: 'transient app' })
      check(`the typed ipfs:// address loaded (${JSON.stringify(loaded.info)})`, loaded.ok)

      const pinned = await waitFor(() => existsSync(pinFile), 25_000)
      check(`the hint installed it: a pin exists for ${origin}`, pinned)
      const pin = pinned ? JSON.parse(readFileSync(pinFile, 'utf8')) as { content?: { cid: string } } : {}
      check(`the pin records the root CID (${JSON.stringify(pin.content)})`, pin.content?.cid === root)
      // The pin lands before the consent step runs, so the question is waited for, never looked for once.
      let asked: QuestionText | undefined
      try {
        asked = await answerAccepting(running)
      } catch (error) {
        check(`the install consent question appeared (${String(error)})`, false)
      }
      const askedFor = (path: string): number => gateway.requests.filter((r) => r.startsWith(`/ipfs/${gateway.blockOf('app', path)}`)).length
      check(`app.js was asked for again after its 502 (${String(askedFor('app.js'))} requests)`, askedFor('app.js') >= 2)
      check(`style.css was asked for again after its 502s (${String(askedFor('style.css'))} requests)`, askedFor('style.css') >= 4)
      const namesApp = asked !== undefined && JSON.stringify(asked).includes(root)
      check(`the install consent question names the app's address (${JSON.stringify(asked)})`, namesApp)

      expect(loaded.ok).toBe(true)
      expect(pinned).toBe(true)
      expect(pin.content?.cid).toBe(root)
      expect(namesApp).toBe(true)
      expect(askedFor('app.js')).toBeGreaterThanOrEqual(2)
      expect(askedFor('style.css')).toBeGreaterThanOrEqual(4)
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
