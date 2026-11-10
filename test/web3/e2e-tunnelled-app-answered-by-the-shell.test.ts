// An allowed .eth site with a tunnel entry of its own, still served live (its pin has not landed), runs only on documents the
// shell's own handler answered, with every file checked, and its live reads leave through that entry's tunnel:
//
//   1. The verifier hands the tunnel profile's page requests to the shell like any other website session's, so the app is
//      entered with its grants, and no read of the shell's (the manifest, the tree, a file) reaches the gateway directly.
//   2. A document the shell did not answer gets no grants, even though the shell serves the app and the tab is the app's:
//      the verifier host is held back from learning the app is served, so the reload is answered from the network (through
//      the tunnel, unchecked). Once the host knows, the next load is the shell's, and the grants are there.
//
// What a page can see of this is `window.orivon.app.grants()`: a document attributed to the origin gets the list, any other
// is denied.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-tunnelled-app-answered-by-the-shell.test.ts
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS, launchElectron } from '../support/launch-electron.mjs'
import { findChrome, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, pageValue, pinPath, withDeclaredTree } from './first-visit-support.js'

type Running = Awaited<ReturnType<typeof launchElectron>>

const GATEWAY = 'gw.socks.test'

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  // The page's own script asks for its grants: a call from anything else (a probe of the shell's) is refused whatever the document is.
  'app.js': 'document.body.dataset.app = "ran"; window.orivon.app.grants().then((grants) => { document.body.dataset.grants = "granted:" + grants.map((grant) => grant.capability).join(",") }, (error) => { document.body.dataset.grants = "rejected:" + (error && error.code) })',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What the app's own script was told when it asked for the grants its document holds: the list, or the refusal; null until it has been told. */
async function grantsOf (app: Running, url: string): Promise<unknown> {
  return await pageValue(app, url, 'document.body?.dataset.grants ?? null')
}

it('serves an allowed tunnelled site that is not pinned yet from the shell, through its tunnel, and gives no grants to a document the shell did not answer', async () => {
  await runPhase('tunnelled-app-answered-by-the-shell', async (check) => {
    const sites = { entry: await withDeclaredTree(files('Tunnelled app', 'tunnelled.app')), held: await withDeclaredTree(files('Held app', 'held.app')) }
    const decoy = await startFixtureGateway(sites)
    const real = await startFixtureGateway(sites)
    const decoyPort = new URL(decoy.url).port
    const socks = await startSocks5Fixture({ preferAuth: true, names: { [`${GATEWAY}:${decoyPort}`]: { host: '127.0.0.1', port: Number(new URL(real.url).port) } } })
    const blocksAsked = (gateway: typeof real): number => gateway.requests.filter((request) => request.endsWith('?format=raw')).length
    let app: Running | undefined
    try {
      const entryOrigin = 'https://entry.eth'
      const heldOrigin = 'https://held.eth'
      app = await launchElectron({
        appPath: '.',
        args: [`--host-resolver-rules=MAP ${GATEWAY} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'entry.eth': `ipfs://${real.roots['entry']}`, 'held.eth': `ipfs://${real.roots['held']}` }),
          ORIVON_TEST_IPFS_GATEWAYS: `http://${GATEWAY}:${decoyPort}`,
          // The download is held back: both apps stay served live, and every file is checked as it is served.
          ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000'
        },
        seedProfile: async (dir) => {
          writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
          // Each site has an entry of its own, on the person's SOCKS5 tunnel: its pages run in that tunnel's profile session.
          writeFileSync(join(dir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [entryOrigin, heldOrigin], via: { [entryOrigin]: 'socks5', [heldOrigin]: 'socks5' }, off: [], apart: [], apartProxy: [entryOrigin, heldOrigin], apartDirect: [] }))
        }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length >= 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      // 1. A site allowed while it is served live is entered with its grants, through the shell, and its reads leave by the tunnel.
      await clickAddressBarRetrying(chrome, 'entry.eth')
      await waitQuestion(running, 90_000)
      await answerQuestion(running, 'Grant all')
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${entryOrigin}/`); return facts?.ran === 'ran' && facts.hasProcess }, 90_000)
      check(`the tab is the app's, entered after Allow (${JSON.stringify(facts)})`, facts?.ran === 'ran' && facts.hasProcess)
      check('the app is still served live: its pin has not landed', !existsSync(pinPath(userData, entryOrigin)))
      let grants: unknown = null
      const granted = await waitFor(async () => { grants = await grantsOf(running, `${entryOrigin}/`); return grants === 'granted:fs' }, 30_000)
      check(`its document, answered by the shell although the site is tunnelled and not pinned, holds its grants (${JSON.stringify(grants)})`, granted)
      check('the gateway was read through the tunnel', socks.requests.some((request) => request.destination === GATEWAY) && blocksAsked(real) > 0)
      check('and never directly, by the page, by the shell\'s own reads of the manifest and the files, or by the check of the tree', blocksAsked(decoy) === 0)

      // 2. The verifier host does not yet know the shell serves the next app: the document it answers itself is not the shell's.
      await running.evaluate(() => { (globalThis as { __orivonDevEthFixtures?: { holdServed?: (hold: boolean) => void } }).__orivonDevEthFixtures?.holdServed?.(true) })
      await clickAddressBarRetrying(chrome, 'held.eth')
      await waitQuestion(running, 90_000)
      await answerQuestion(running, 'Grant all')
      let held = null as PageFacts | null
      await waitFor(async () => { held = await pageAt(running, `${heldOrigin}/`); return held?.ran === 'ran' && held.hasProcess }, 90_000)
      check(`the tab is the app's, though the host has not been told (${JSON.stringify(held)})`, held?.ran === 'ran' && held.hasProcess)
      let refused: unknown = null
      await waitFor(async () => { refused = await grantsOf(running, `${heldOrigin}/`); return refused !== null }, 20_000)
      check(`a document the shell did not answer is denied the grants (${JSON.stringify(refused)})`, refused === 'rejected:denied')
      check('and its network answer still left through the tunnel', blocksAsked(decoy) === 0)

      // The host is told: the next load is the shell's, and the grants are there.
      await running.evaluate(() => { (globalThis as { __orivonDevEthFixtures?: { holdServed?: (hold: boolean) => void } }).__orivonDevEthFixtures?.holdServed?.(false) })
      const [tab] = await tabIds(chrome) as string[]
      await chrome.evaluate((id: string) => { (window as unknown as { orivonShell: { reload: (tab: string) => void } }).orivonShell.reload(id) }, tab as string)
      let after: unknown = null
      const answered = await waitFor(async () => { after = await grantsOf(running, `${heldOrigin}/`); return after === 'granted:fs' }, 60_000)
      check(`once the host knows, the reloaded document is the shell's and holds its grants (${JSON.stringify(after)})`, answered)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await socks.close()
      await decoy.close()
      await real.close()
    }
  })
}, TEST_TIMEOUT_MS)
