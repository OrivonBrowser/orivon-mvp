// A108/C-07's end-to-end proof, and it exists because this exact area has
// already shipped broken once: #110's session partitioning passed every unit
// test and did nothing at all in a real window -- both tabs sat on the
// default session. A unit test cannot reach what this file tests.
//
// Only a CACHE-SERVED origin gets its own partition now (2026-09-29). The
// destination here is a REAL, reachable loopback HTTP origin (so the
// redirect's first hop, which runs inside the REDIRECTOR's own session --
// the default session, since the redirector itself holds no grant and is
// never cache-served -- can actually complete under HERMETIC_RESOLVER), and
// is ALSO pinned and registered as cache-served, at its own real origin,
// through the same dev-only hook `e2e-serve-from-cache.test.ts` uses. A
// synthetic, network-unreachable `.test` destination (that file's own
// ORIGIN) cannot stand in for it here: the redirect's first hop would have
// nowhere to go, since protocol.handle only intercepts inside the
// destination's OWN partition, not the redirector's.
//
// TWO THINGS ONLY A REAL LAUNCH CAN ANSWER, and the second is why this file
// was written by the conductor rather than the lane:
//   1. Does a real HTTP redirect that lands on a cache-served origin actually
//      put the tab in THAT origin's own partition, with the cache handler --
//      not the real server that answered the redirect's first hop -- serving
//      the page once it lands there? did-navigate's committed URL is the
//      only thing that knows, and Chromium is the only thing that fires it.
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
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/cache/node-storage.js'

const PINNED_TITLE = 'destination (from cache)'
const REAL_SERVER_TITLE = 'destination (from the real server -- should never be the final title)'
const INDEX_HTML = `<!doctype html><html><head><title>${PINNED_TITLE}</title></head><body>${PINNED_TITLE}</body></html>`
const MANIFEST_JSON = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.redirect-dest-e2e',
  name: 'Redirect-destination e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: {}
})

/** Writes a real, valid pin for `origin` directly to `userDataDir` -- the
 * same bundleTree()/fromBundleTree() construction `e2e-serve-from-cache.test.ts`
 * uses, called from the test process rather than through a network fetch. */
async function pinDestination (userDataDir: string, origin: string): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(MANIFEST_JSON) },
    { path: '/index.html', content: new TextEncoder().encode(INDEX_HTML) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

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
  16_000 +
  8_000 * 2 +
  APP_CLOSE_RACE_MS
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 20_000

it('a cross-origin HTTP redirect that lands on a CACHE-SERVED origin puts the tab in that origin\'s own partition, and closing the old view from inside its own did-navigate handler does not take the process down', async () => {
  // A real server, reachable over real loopback network -- so the
  // redirect's first hop (inside the redirector's own, unpartitioned
  // session) has somewhere to land -- but whose response must NEVER be
  // what the tab finally shows, once protocol.handle takes over on the
  // repartitioned view.
  destination = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>${REAL_SERVER_TITLE}</title><body>${REAL_SERVER_TITLE}</body>`)
  })
  const destOrigin = await listen(destination)

  redirector = createServer((_req, res) => {
    res.writeHead(302, { location: `${destOrigin}/` })
    res.end()
  })
  const redirectOrigin = await listen(redirector)

  await runPhase('cross-origin redirect into a cache-served origin repartitions the tab', async (check) => {
    const fromUrl = `${redirectOrigin}/`
    const toUrl = `${destOrigin}/`
    const partitionTo = partitionFor(originFromUrl(toUrl) as string)
    const wouldBePartitionFrom = partitionFor(originFromUrl(fromUrl) as string)
    check('the redirector and the destination are genuinely different origins', fromUrl !== toUrl)
    check('their partitions are genuinely different strings', wouldBePartitionFrom !== partitionTo)

    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const ready = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', ready)

      const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await pinDestination(userDataDir, originFromUrl(toUrl) as string)

      // ---- Register serving for the destination, for real, through the
      // dev-only hook (the same one e2e-serve-from-cache.test.ts uses) --
      // BEFORE the redirect ever fires, so isOriginServedFromCacheSync
      // already answers true by the time did-navigate asks it. ----
      const registerOutcome = await app.evaluate(async (_electron, origin: string) => {
        const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
        if (typeof hook !== 'function') return { hookPresent: false as const }
        await hook(origin)
        return { hookPresent: true as const }
      }, originFromUrl(toUrl) as string)
      check(
        'the dev-only serve-registration hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
        registerOutcome.hookPresent,
        registerOutcome.hookPresent ? undefined : 'globalThis.__orivonDevRegisterServing was not a function in the main process'
      )
      if (!registerOutcome.hookPresent) throw new Error('dev-serve hook missing -- was this built via npm run test:e2e?')

      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)
      // Typed into the address bar, so navigate() computes the REDIRECTOR's
      // (lack of a) partition up front -- exactly the pre-redirect value
      // A108 says the tab wrongly keeps.
      await clickAddressBarRetrying(chrome, fromUrl)

      const landed = await waitForTab(chrome, { address: toUrl, title: PINNED_TITLE })
      check(
        'the tab follows the redirect, ends on the destination origin, and the FINAL page came from the ' +
        'cache handler (its pinned title), not the real server that only answered the redirect\'s first hop',
        landed.ok,
        landed.ok ? undefined : JSON.stringify(landed.info)
      )

      // THE ASSERTION. A WebContents' real `.session` is only observable from
      // the main process, which is the lesson e2e-session-partitions.test.ts
      // records: a page-level check could not tell a partitioned build from
      // an unpartitioned one.
      const seen = await app.evaluate(({ webContents, session }, args: { toUrl: string, partitionTo: string, wouldBePartitionFrom: string }) => {
        const wc = webContents.getAllWebContents().find((c) => c.getURL() === args.toUrl)
        if (wc === undefined) return { found: false as const }
        return {
          found: true as const,
          isDestinationPartition: wc.session === session.fromPartition(args.partitionTo),
          isRedirectorsWouldBePartition: wc.session === session.fromPartition(args.wouldBePartitionFrom),
          isDefaultSession: wc.session === session.defaultSession
        }
      }, { toUrl, partitionTo, wouldBePartitionFrom })

      check('the destination page is findable in the main process', seen.found, JSON.stringify(seen))
      if (!seen.found) return

      check("the tab is on the CACHE-SERVED DESTINATION origin's own partition after the redirect",
        seen.isDestinationPartition, JSON.stringify(seen))
      check('the tab is NOT on the redirector\'s own would-be partition (it was never cache-served, so it never gets one)',
        !seen.isRedirectorsWouldBePartition, JSON.stringify(seen))
      check('the tab did not stay on the default session, where the redirect\'s first hop landed',
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
