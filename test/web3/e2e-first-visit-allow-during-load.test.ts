// Allow answered while a first visit is still loading an app of several large files: the tab reloads as the app,
// every script reaches it however large the files are together, and what was already read is not downloaded again.
// The gateway is one slow link shared by every block, so the answer comes while most of the app is still on its way.
import { randomBytes } from 'node:crypto'
import { afterAll, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import type { PageFacts } from './first-visit-support.js'
import { pageAt, pinPath, withDeclaredTree } from './first-visit-support.js'

const PARTS = ['part-0.js', 'part-1.js', 'part-2.js', 'part-3.js']
const PART_BYTES = 24 * 1024 * 1024
const BLOCK_BYTES = 256 * 1024
const BLOCKS = PARTS.length * PART_BYTES / BLOCK_BYTES
const LINK_BYTES_PER_SECOND = 8 * 1024 * 1024

/** A script of PART_BYTES: a comment of random text, so no block of the app equals another, then the statement that counts it. */
function part (): string {
  const count = '\nwindow.__seen = (window.__seen ?? 0) + 1\n'
  return `/*${randomBytes(Math.floor((PART_BYTES - count.length - 4) / 2)).toString('hex')}*/${count}`
}

const files = (): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>Large files app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>Large files app${PARTS.map((path) => `<script src="${path}"></script>`).join('')}<script src="last.js"></script></body>`,
  ...Object.fromEntries(PARTS.map((path) => [path, part()])),
  'last.js': 'document.body.dataset.app = String(window.__seen)',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id: 'first.visit.allow.during.load', name: 'Large files app', version: '1.0.0', entry: 'index.html', assets: [...PARTS, 'last.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 240_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-allow-keeps-the-files] reloads the tab as the app on Allow while its large files are still arriving, with every script reaching the app and what was read not downloaded again', async () => {
  await runPhase('first-visit-allow-during-load', async (check) => {
    const gateway = await startFixtureGateway({ large: await withDeclaredTree(files()) }, { linkBytesPerSecond: LINK_BYTES_PER_SECOND })
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
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      const root = gateway.roots['large']!
      const origin = `https://${root}.ipfs.orivon`
      const blocksAsked = (): number => gateway.requests.filter((request) => request.startsWith('/ipfs/')).length

      // The question is answered a quarter of the way through the download.
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      check('a quarter of the app is read before the answer', await waitFor(() => blocksAsked() >= BLOCKS / 4, 60_000))
      const askedBefore = new Set(gateway.requests)
      const countBefore = gateway.requests.length
      await answerQuestion(running, 'Grant all')

      // Allow reloads the tab as the app: all four scripts arrive, so the last one sees four.
      let facts = null as PageFacts | null
      await waitFor(async () => { facts = await pageAt(running, `${origin}/`); return facts?.hasProcess === true && facts.ran === String(PARTS.length) }, 90_000)
      check(`the tab reloaded as an app tab and all ${String(PARTS.length)} scripts ran (${JSON.stringify(facts)})`, facts?.hasProcess === true && facts.ran === String(PARTS.length))

      // The app is pinned once everything is read, so the requests have settled by then.
      check('the whole app is pinned', await waitFor(() => existsSync(pinPath(userData, origin)), 120_000))
      const again = new Set(gateway.requests.slice(countBefore).filter((request) => askedBefore.has(request)))
      check(`what was already read was not asked for again beyond the reads in flight (${String(again.size)} of ${String(BLOCKS)})`, again.size < BLOCKS / 10)
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
