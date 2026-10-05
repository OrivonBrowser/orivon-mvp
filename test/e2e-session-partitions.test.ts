// The end-to-end proof that a GRANT ALONE does not isolate an origin: only a
// cache-served origin gets its own Electron session partition, because
// Chrome extensions load into session.defaultSession and must run as one
// instance on every page, granted apps included -- so a granted,
// network-served app shares that session too.
// `e2e-redirect-partition.test.ts` is where a CACHE-SERVED origin's own
// partition is proven, through a real redirect landing a tab in it.
//
// WHY THIS DOES NOT JUST READ localStorage FROM TWO PAGES. Two unrelated
// origins already cannot see each other's localStorage/cookies under
// Chromium's own same-origin policy, in a SINGLE shared Electron session --
// that isolation exists regardless of this change, so a test that only
// proved that would pass whether or not this file's own rule ever shipped.
// What is actually being proven is WHICH Electron `session` object each
// tab's WebContents uses, and that a granted origin's storage still comes
// apart cleanly from another origin's even while both share one session --
// both only observable from the Electron MAIN process, via `app.evaluate()`.
// So this file proves three things, and the second is the genuinely
// discriminating one (see "Assertion 2" for exactly why):
//   1. Both tabs' `webContents.session` really is `session.defaultSession`.
//   2. Neither tab's session is the partition `partitionFor(originFromUrl(url))`
//      WOULD compute -- i.e. granting the origin did not mint that partition
//      and quietly use it anyway.
//   3. Clearing ORIGIN A's data on the shared default session, by origin
//      (`session.defaultSession.clearData({ origins: [originA] })`, the same
//      call `site-info-ipc.ts`'s own "clear browsing data for this site"
//      makes), clears tab A's own localStorage but leaves tab B's untouched.
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-session-partitions.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron } from './support/launch-electron.mjs'
import {
  evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab
} from './support/smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase,
  waitForAddressBarStable
} from './support/e2e-helpers.js'
import { DEFAULT_ACTION_TIMEOUT_MS } from './support/launch-electron.mjs'
import { originFromUrl } from '../src/broker/policy/origin.js'
import { partitionFor } from '../src/broker/grants/origin-hash.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

/** The smallest manifest the dev-grant hook will register. `id` is the
 * least interesting capability on purpose: this file is about WHICH
 * session a granted tab lands in, not about what the grant permits. */
const FIXTURE_MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.partition-fixture',
  name: 'Session-partition fixture',
  version: '0.1.0',
  entry: 'index.html',
  capabilities: {}
}

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

it('two tabs opened against two GRANTED, network-served origins share the shell\'s default session, not a partition each, and clearing one origin\'s data by name leaves the other\'s untouched', async () => {
  // Started outside runPhase, deliberately: a fixture-server startup failure
  // should surface as an uncaught test error, not a silently reported phase.
  const startedA = await startOriginServer('origin-a')
  const startedB = await startOriginServer('origin-b')
  serverA = startedA.server
  serverB = startedB.server
  const originA = `${startedA.origin}/`
  const originB = `${startedB.origin}/`

  await runPhase('two-origin session partition isolation', async (check) => {
    const wouldBePartitionA = partitionFor(originFromUrl(originA) as string)
    const wouldBePartitionB = partitionFor(originFromUrl(originB) as string)
    check('the two fixture origins really are different origins', originA !== originB)
    check('their would-be partitions really are different strings', wouldBePartitionA !== wouldBePartitionB)

    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })

      const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', windowsReady, windowsReady ? undefined : `saw ${app.windows().length} window(s)`)

      // ---- Grant both origins: a HELD GRANT is exactly the case this file
      // exists to prove does not earn a partition ----
      const granted = await app.evaluate(async (_electron, requests: DevGrantRequest[]) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        for (const request of requests) await hook(request)
        return { installed: true as const }
      }, [originA, originB].map((url) => ({
        // The hook keys the ledger by canonical origin; these are full URLs.
        origin: originFromUrl(url) as string,
        manifest: FIXTURE_MANIFEST,
        capability: 'id' as const,
        patterns: []
      })) satisfies DevGrantRequest[])
      check(
        'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
        granted.installed,
        granted.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
      )
      if (!granted.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

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

      // ---- Assertion 1 & 2: both tabs share the default session, and
      // granting them did NOT quietly mint a partition for either ----
      const identity = await app.evaluate(({ webContents, session }, args: { urlA: string, urlB: string, wouldBePartitionA: string, wouldBePartitionB: string }) => {
        const all = webContents.getAllWebContents()
        const wcA = all.find((wc) => wc.getURL() === args.urlA)
        const wcB = all.find((wc) => wc.getURL() === args.urlB)
        if (wcA === undefined || wcB === undefined) {
          return { found: false as const }
        }
        return {
          found: true as const,
          aIsDefaultSession: wcA.session === session.defaultSession,
          bIsDefaultSession: wcB.session === session.defaultSession,
          aIsNotItsWouldBePartition: wcA.session !== session.fromPartition(args.wouldBePartitionA),
          bIsNotItsWouldBePartition: wcB.session !== session.fromPartition(args.wouldBePartitionB)
        }
      }, { urlA: originA, urlB: originB, wouldBePartitionA, wouldBePartitionB })

      check('both tabs\' webContents are found in the main process', identity.found)
      if (identity.found) {
        check('tab A runs on session.defaultSession, not a partition of its own', identity.aIsDefaultSession)
        check('tab B runs on session.defaultSession, not a partition of its own', identity.bIsDefaultSession)
        check('granting origin A did not mint the partition it WOULD have had under the old, grant-isolates rule', identity.aIsNotItsWouldBePartition)
        check('granting origin B did not mint the partition it WOULD have had under the old, grant-isolates rule', identity.bIsNotItsWouldBePartition)
      }

      // ---- Assertion 3: clearing A's data BY ORIGIN, on the shared default
      // session, does not touch B's -- the same call site-info-ipc.ts's own
      // "clear browsing data for this site" makes (tab.session.clearData({
      // origins: [origin] })), now usually against session.defaultSession
      // rather than a partition of its own. ----
      await evaluateRetrying(viewA, () => { window.localStorage.setItem('probe', 'A') })
      await evaluateRetrying(viewB, () => { window.localStorage.setItem('probe', 'B') })

      await app.evaluate(({ session }, args: { originA: string }) => {
        return session.defaultSession.clearData({ origins: [args.originA] })
      }, { originA: originFromUrl(originA) as string })

      await viewA.reload()
      const probeAAfterClear = await evaluateRetrying(viewA, () => window.localStorage.getItem('probe'))
      check(
        'clearing origin A BY NAME on the shared default session wipes tab A\'s own localStorage -- proves ' +
        'session.clearData({ origins }) genuinely scopes to that origin, even though the session itself is shared',
        probeAAfterClear === null,
        `saw ${JSON.stringify(probeAAfterClear)}`
      )

      const probeBAfterClear = await evaluateRetrying(viewB, () => window.localStorage.getItem('probe'))
      check(
        'tab B\'s own localStorage is UNTOUCHED by clearing origin A\'s data on the SAME shared session',
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
