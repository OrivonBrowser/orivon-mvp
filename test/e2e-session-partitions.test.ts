// The end-to-end proof for build-plan.md step 2's last deliverable
// (docs/planning/unattended-build-queue.md item 0.4): "tabs open in the
// app's own partition; a test proves two origins share no storage."
//
// WHY THIS DOES NOT JUST READ localStorage FROM TWO PAGES. Two unrelated
// origins already cannot see each other's localStorage/cookies under
// Chromium's own same-origin policy, in a SINGLE shared Electron session --
// that isolation exists with or without src/main/tabs.ts's own partition
// wiring, so a test that only proved that would pass whether or not this
// lane's change ever shipped. What actually changed here is WHICH Electron
// `session` object each tab's WebContents uses -- ADR-0003's "a dedicated
// session partition per origin" -- and that is only observable from the
// Electron MAIN process, via `app.evaluate()`, not from page-level
// `evaluate()` calls. So this file proves two things, and only the second
// is genuinely discriminating (see "Assertion 2" below for exactly why):
//   1. Each tab's `webContents.session` is the SAME object
//      `session.fromPartition(partitionFor(originFromUrl(url)))` returns --
//      i.e. src/main/tabs.ts really did assign the partition this lane
//      built, not merely "some" non-default session.
//   2. Wiping ORIGIN A's partition from the main process clears tab A's own
//      localStorage but leaves tab B's untouched -- which is what "share no
//      storage" means in a way an unpartitioned build would fail.
//
// RUN THIS WITH: (needs a real Electron launch -- see this repo's
// CLAUDE.md/orivon-electron skill for why one is never started directly)
//
//   npx electron-vite build && npx vitest run --config test/vitest.e2e.config.ts test/e2e-session-partitions.test.ts
//
// NOT RUN AS PART OF THIS LANE'S OWN VERIFICATION -- see the PR body. The
// lane that built this had no Electron launch token (another lane held it),
// so this file is written and reasoned through as if it were about to run,
// never executed locally.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import {
  evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab
} from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase,
  waitForAddressBarStable
} from './e2e-helpers.js'
import { DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { originFromUrl } from '../src/broker/policy/origin.js'
import { partitionFor } from '../src/broker/grants/origin-hash.js'

/** A trivial, single-page HTTP origin -- no fixture app, no manifest, this
 * test only needs two distinct real origins to navigate to. Mirrors
 * scripts/smoke.mjs's own inline startFixtureServer(), not reused from it
 * directly: that function is private to smoke.mjs, and duplicating five
 * lines here is cheaper than exporting it across an unrelated file for one
 * caller. */
async function startOriginServer (title: string): Promise<{ server: Server, origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<title>${title}</title><body>${title}</body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

async function stopServer (server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

let serverA: Server | undefined
let serverB: Server | undefined

afterAll(async () => {
  await Promise.all([serverA, serverB].map(async (server) => { if (server !== undefined) await stopServer(server) }))
  // The suite's own self-check (unattended-run-protocol.md): after the
  // test's own app has torn itself down, nothing this file launched may
  // still be a live Electron process.
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Sum of every wait this test's real path can hit, walked in call order --
 * same accounting style as e2e-capability-boundary.test.ts's
 * PHASE1_WAIT_BUDGET_MS, halved in spirit because this file drives two
 * navigations of the SAME shape rather than one plus a retry-worst-case. */
const WAIT_BUDGET_MS =
  8_000 + // initial two-window wait
  (ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3) * 2 + // two navigations, each: stable + click/fill/press
  8_000 * 2 + // two waitForTab confirmations
  8_000 + // new-tab-becomes-active wait
  8_000 + // teardown: windows -> 0
  APP_CLOSE_RACE_MS // teardown: app.close() race
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 20_000

it('two tabs opened against two different origins use two different, correctly-named Electron session partitions, and wiping one leaves the other\'s storage untouched', async () => {
  // Started outside runPhase, deliberately: a fixture-server startup failure
  // should surface as an uncaught test error, not a silently reported phase.
  const startedA = await startOriginServer('origin-a')
  const startedB = await startOriginServer('origin-b')
  serverA = startedA.server
  serverB = startedB.server
  const originA = `${startedA.origin}/`
  const originB = `${startedB.origin}/`

  await runPhase('two-origin session partition isolation', async (check) => {
    const expectedPartitionA = partitionFor(originFromUrl(originA) as string)
    const expectedPartitionB = partitionFor(originFromUrl(originB) as string)
    check('the two fixture origins really are different origins', originA !== originB)
    check('their expected partitions really are different strings', expectedPartitionA !== expectedPartitionB)

    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })

      const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', windowsReady, windowsReady ? undefined : `saw ${app.windows().length} window(s)`)

      const chrome = findChrome(app)

      // ---- Tab 1 (the initial dashboard tab): navigate it to origin A ----
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, originA)
      const navA = await waitForTab(chrome, { address: originA, title: 'origin-a' })
      check('tab 1 navigates to origin A over real localhost HTTP', navA.ok, navA.ok ? undefined : JSON.stringify(navA.info))

      // ---- Tab 2 (a genuinely new tab): navigate it to origin B ----
      await chrome.click('#new-tab')
      const idsAfterNewTab = await waitFor(async () => (await tabIds(chrome)).length === 2)
      check('opening a new tab makes two tabs', idsAfterNewTab)

      const ids = await tabIds(chrome)
      const tab2Id = ids[1]
      const tab2Active = await waitForTab(chrome, { activeId: tab2Id })
      check('the new tab becomes the active one before anything is typed into it', tab2Active.ok, tab2Active.ok ? undefined : JSON.stringify(tab2Active.info))

      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, originB)
      const navB = await waitForTab(chrome, { address: originB, title: 'origin-b' })
      check('tab 2 navigates to origin B over real localhost HTTP', navB.ok, navB.ok ? undefined : JSON.stringify(navB.info))

      const viewA = findViewShowing(app, chrome, originA)
      const viewB = findViewShowing(app, chrome, originB)
      check('both tabs are identifiable by their own URL', viewA !== undefined && viewB !== undefined)
      if (viewA === undefined || viewB === undefined) return

      // ---- Assertion 1: each tab really is on the partition this lane assigns it ----
      // getAllWebContents/session are read from the MAIN process (app.evaluate),
      // because that is the only place a WebContents' actual `.session` object
      // is observable -- see this file's header for why page-level localStorage
      // checks alone would not distinguish this from the unpartitioned build.
      const identity = await app.evaluate(({ webContents, session }, args: { urlA: string, urlB: string, expectedPartitionA: string, expectedPartitionB: string }) => {
        const all = webContents.getAllWebContents()
        const wcA = all.find((wc) => wc.getURL() === args.urlA)
        const wcB = all.find((wc) => wc.getURL() === args.urlB)
        if (wcA === undefined || wcB === undefined) {
          return { found: false as const }
        }
        return {
          found: true as const,
          aMatchesExpectedPartition: wcA.session === session.fromPartition(args.expectedPartitionA),
          bMatchesExpectedPartition: wcB.session === session.fromPartition(args.expectedPartitionB),
          aDiffersFromB: wcA.session !== wcB.session,
          aDiffersFromDefault: wcA.session !== session.defaultSession,
          bDiffersFromDefault: wcB.session !== session.defaultSession
        }
      }, { urlA: originA, urlB: originB, expectedPartitionA, expectedPartitionB })

      check('both tabs\' webContents are found in the main process', identity.found)
      if (identity.found) {
        check('tab A uses exactly session.fromPartition(partitionFor(originFromUrl(originA)))', identity.aMatchesExpectedPartition)
        check('tab B uses exactly session.fromPartition(partitionFor(originFromUrl(originB)))', identity.bMatchesExpectedPartition)
        check('tab A and tab B are on two DIFFERENT session objects', identity.aDiffersFromB)
        check('tab A is not on session.defaultSession', identity.aDiffersFromDefault)
        check('tab B is not on session.defaultSession', identity.bDiffersFromDefault)
      }

      // ---- Assertion 2: wiping A's partition storage does not touch B's ----
      // THIS is the discriminating half (see file header): under the OLD,
      // unpartitioned code every tab shared session.defaultSession, so
      // `session.fromPartition(expectedPartitionA)` would resolve to a brand
      // new, never-used partition -- clearing it would do nothing to tab A's
      // REAL storage (which would still live in defaultSession), and this
      // first check would correctly FAIL. Under the fix, tab A's real
      // storage lives in exactly that partition, so clearing it and reading
      // back localStorage after a reload must show the value is gone.
      await evaluateRetrying(viewA, () => { window.localStorage.setItem('probe', 'A') })
      await evaluateRetrying(viewB, () => { window.localStorage.setItem('probe', 'B') })

      await app.evaluate(({ session }, args: { expectedPartitionA: string }) => {
        return session.fromPartition(args.expectedPartitionA).clearStorageData()
      }, { expectedPartitionA })

      await viewA.reload()
      const probeAAfterClear = await evaluateRetrying(viewA, () => window.localStorage.getItem('probe'))
      check(
        'clearing origin A\'s own partition wipes tab A\'s own localStorage -- proves A\'s ' +
        'storage genuinely lives in the partition this lane assigned it, not in a shared/default session',
        probeAAfterClear === null,
        `saw ${JSON.stringify(probeAAfterClear)}`
      )

      const probeBAfterClear = await evaluateRetrying(viewB, () => window.localStorage.getItem('probe'))
      check(
        'tab B\'s own localStorage is UNTOUCHED by clearing origin A\'s partition -- the two ' +
        'origins share no storage',
        probeBAfterClear === 'B',
        `saw ${JSON.stringify(probeBAfterClear)}`
      )
    } finally {
      // Shared teardown -- see e2e-helpers.ts's closeElectronApp for the
      // close-hang workaround this performs, and launch-electron.mjs's
      // closeElectron for why it now runs unconditionally.
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
