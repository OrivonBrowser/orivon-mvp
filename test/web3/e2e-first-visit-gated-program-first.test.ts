// An app whose first page does not start its main program: a bridge script writes the main script only once the tab is an
// app tab, so the main file is first needed on the reload after Allow. The download that runs beside the question reads
// that file before the many files nothing names, so Allow does not wait for it. Read from the gateway's own record of
// the blocks it was asked for, in the order it was asked, never from a clock.
import { randomBytes } from 'node:crypto'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, withDeclaredTree } from './first-visit-support.js'

/** Named so they sort, and are listed, before the bridge and the main file, as a bundler's output is. */
const FILLERS = Array.from({ length: 40 }, (_, i) => `${String(1001 + i * 16)}.chunk.js`)
const FILLER_BYTES = 512 * 1024
const MAIN_BYTES = 4 * 1024 * 1024
const LINK_BYTES_PER_SECOND = 4 * 1024 * 1024

/** A script of about `bytes`: a comment of random text, so no block of the app equals another, then `statement`. */
function script (bytes: number, statement = ''): string {
  return `/*${randomBytes(Math.floor((bytes - statement.length - 4) / 2)).toString('hex')}*/${statement}`
}

const files = (): Record<string, string> => ({
  'index.html': '<!doctype html><meta charset="utf-8"><title>Gated program app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>Gated program app<script src="bridge.js"></script></body>',
  ...Object.fromEntries(FILLERS.map((path) => [path, script(FILLER_BYTES)])),
  'bridge.js': 'if (typeof process !== \'undefined\') document.write(\'<script defer src="./main.bundle.js"></script>\')',
  'main.bundle.js': script(MAIN_BYTES, '\ndocument.body.dataset.app = "main"\n'),
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id: 'first.visit.gated.program', name: 'Gated program app', version: '1.0.0', entry: 'index.html', assets: [...FILLERS, 'bridge.js', 'main.bundle.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-reads-the-gated-program-first] reads the main file a bridge script starts only once the tab is an app before the files nothing names, and runs it on Allow', async () => {
  await runPhase('first-visit-gated-program-first', async (check) => {
    const gateway = await startFixtureGateway({ gated: await withDeclaredTree(files()) }, { linkBytesPerSecond: LINK_BYTES_PER_SECOND })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      const root = gateway.roots['gated']!
      const origin = `https://${root}.ipfs.orivon`
      /** Where in the gateway's record the first request for this file's block stands, or -1 while it has not been asked for. */
      const askedAt = (path: string): number => gateway.requests.findIndex((request) => request.split('?')[0] === `/ipfs/${gateway.blockOf('gated', path)}`)

      // Nothing is pressed: the question stays open while the download goes on.
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      const mainAsked = await waitFor(() => askedAt('main.bundle.js') >= 0, 60_000)
      check('the main file is asked for while the question is open', mainAsked)
      const mainAt = askedAt('main.bundle.js')
      const askedBefore = FILLERS.filter((path) => { const at = askedAt(path); return at >= 0 && at < mainAt }).length
      check(`the main file is asked for before most of the files nothing names (${String(askedBefore)} of ${String(FILLERS.length)} were asked for first)`, mainAsked && askedBefore < FILLERS.length / 2)

      // Allow reloads the tab as the app: the bridge sees `process`, writes the main script, and that script runs.
      await answerQuestion(running, 'Grant all')
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${origin}/`); return facts?.hasProcess === true && facts.ran === 'main' }, 90_000)
      check(`the tab reloaded as an app tab and its main script ran (${JSON.stringify(facts)})`, facts?.hasProcess === true && facts.ran === 'main')
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
