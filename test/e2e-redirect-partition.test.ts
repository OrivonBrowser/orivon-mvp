// A108/C-07's end-to-end proof, and it exists because this exact area has
// already shipped broken once: #110's session partitioning passed every unit
// test and did nothing at all in a real window -- both tabs sat on the
// default session. A unit test cannot reach what this file tests.
//
// TWO THINGS ONLY A REAL LAUNCH CAN ANSWER, and the second is why this file
// was written by the conductor rather than the lane:
//   1. Does a real HTTP redirect that changes origin actually land the tab in
//      the DESTINATION's partition? did-navigate's committed URL is the only
//      thing that knows, and Chromium is the only thing that fires it.
//   2. Is it safe to close a view's own webContents from inside that same
//      view's did-navigate handler? repartitionView() was previously only
//      ever called from the top-level navigate(); reaching it from an event
//      handler on the view being destroyed is a NEW reentrant pattern. If
//      Electron dislikes it, the failure is a main-process crash or a hang,
//      neither of which any unit test would show.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase,
  waitForAddressBarStable
} from './e2e-helpers.js'
import { originFromUrl } from '../src/broker/policy/origin.js'
import { partitionFor } from '../src/broker/grants/origin-hash.js'

let redirector: Server | undefined
let destination: Server | undefined

async function listen (server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return `http://127.0.0.1:${String(address.port)}`
}

async function stopServer (server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

afterAll(async () => {
  await Promise.all([redirector, destination].map(async (s) => { if (s !== undefined) await stopServer(s) }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const WAIT_BUDGET_MS =
  8_000 +
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 +
  12_000 +
  8_000 +
  APP_CLOSE_RACE_MS
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 20_000

it('a cross-origin HTTP redirect lands the tab in the DESTINATION origin\'s partition, and closing the old view from inside its own did-navigate handler does not take the process down', async () => {
  destination = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>destination</title><body>destination</body>')
  })
  const destOrigin = await listen(destination)

  redirector = createServer((_req, res) => {
    res.writeHead(302, { location: `${destOrigin}/` })
    res.end()
  })
  const redirectOrigin = await listen(redirector)

  await runPhase('cross-origin redirect repartitions the tab', async (check) => {
    const fromUrl = `${redirectOrigin}/`
    const toUrl = `${destOrigin}/`
    const partitionFrom = partitionFor(originFromUrl(fromUrl) as string)
    const partitionTo = partitionFor(originFromUrl(toUrl) as string)
    check('the two fixture origins are genuinely different', fromUrl !== toUrl)
    check('their partitions are genuinely different strings', partitionFrom !== partitionTo)

    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const ready = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', ready)

      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)
      // Typed into the address bar, so navigate() computes the REDIRECTOR's
      // partition up front -- exactly the pre-redirect value A108 says the
      // tab wrongly keeps.
      await clickAddressBarRetrying(chrome, fromUrl)

      const landed = await waitForTab(chrome, { address: toUrl, title: 'destination' })
      check('the tab follows the redirect and ends on the destination origin', landed.ok,
        landed.ok ? undefined : JSON.stringify(landed.info))

      // THE ASSERTION. A WebContents' real `.session` is only observable from
      // the main process, which is the lesson e2e-session-partitions.test.ts
      // records: a page-level check could not tell a partitioned build from
      // an unpartitioned one.
      const seen = await app.evaluate(({ webContents, session }, args: { toUrl: string, partitionTo: string, partitionFrom: string }) => {
        const wc = webContents.getAllWebContents().find((c) => c.getURL() === args.toUrl)
        if (wc === undefined) return { found: false as const }
        return {
          found: true as const,
          isDestinationPartition: wc.session === session.fromPartition(args.partitionTo),
          isRedirectorPartition: wc.session === session.fromPartition(args.partitionFrom),
          isDefaultSession: wc.session === session.defaultSession
        }
      }, { toUrl, partitionTo, partitionFrom })

      check('the destination page is findable in the main process', seen.found, JSON.stringify(seen))
      if (!seen.found) return

      check("the tab is on the DESTINATION origin's partition after the redirect (A108's fix)",
        seen.isDestinationPartition, JSON.stringify(seen))
      check("the tab is NOT still on the pre-redirect origin's partition (A108's defect)",
        !seen.isRedirectorPartition, JSON.stringify(seen))
      check('the tab did not fall back to the default session',
        !seen.isDefaultSession, JSON.stringify(seen))

      // If the reentrant close() had taken the main process down, every call
      // above would have failed -- but assert liveness explicitly so a future
      // reader knows it was checked rather than inferred.
      const alive = await app.evaluate(({ app: electronApp }) => electronApp.isReady())
      check('the main process survived closing a view from inside its own did-navigate handler', alive === true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
