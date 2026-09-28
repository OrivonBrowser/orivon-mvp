// End-to-end proof of ADR-0007's serve-from-cache half (build step 4,
// lane S4-3-serve): src/loader/serve/serve.ts + src/loader/electron/serve.ts.
//
// WHY A REAL ELECTRON LAUNCH, NOT JUST src/loader/serve/tests/serve.test.ts's
// unit coverage. A unit test of the pinned-set predicate alone does not
// prove the real `protocol.handle` REGISTRATION actually consults it, or
// that it is genuinely scoped to the app's own partition rather than
// leaking globally -- exactly the class of gap docs/development/testing.md
// names for why e2e-capability-boundary.test.ts exists at all. This test
// pins a real app directly to the real, running shell's own on-disk
// storage (the same node-storage.ts functions install() itself calls,
// invoked here from the test process rather than through a network fetch --
// see below for why), then proves from a REAL page, in a REAL registered
// partition, that: cached content loads with no server ever having existed
// for it; a file planted directly on disk outside the pinned manifest is
// refused; and the handler never reaches the default session.
//
// WHY THIS DOES NOT DRIVE A REAL Loader.load() (fetch/bundle.ts).
// install-origin.ts's ensurePublicUnicastOrigin refuses every non-https,
// non-public-unicast install origin with NO exception (A46) -- so a
// loopback fixture server, the only kind an e2e suite can stand up
// hermetically under HERMETIC_RESOLVER, can never complete a real load().
// That check belongs to the FETCH half of src/loader/ and has nothing to do
// with the SERVE half this lane builds: serving reads back whatever is
// already validly pinned on disk, regardless of how it got there. So this
// test writes a real, valid pin (real bundleTree/fromBundleTree, the exact
// construction install() itself uses) directly via node-storage.ts, then
// calls src/loader/dev-serve.ts's `__orivonDevRegisterServing` hook --
// reachable only via Playwright's ElectronApplication.evaluate(), never
// window.orivon or IPC, present only because npm run test:e2e builds with
// ORIVON_ENABLE_DEV_GRANT=1 (scripts/build-e2e.mjs; dev-serve.ts shares
// dev-grant.ts's own flag rather than adding a second one -- see its
// header) -- to register that pin's serving for real, exactly as
// `onInstalled` would once a real https install completes.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-serve-from-cache.test.ts
import { afterAll, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, findChrome, findViewShowing, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { appRootDirectoryName } from '../src/loader/cache/storage.js'
import { nodeLoaderStorage } from '../src/loader/cache/node-storage.js'
import { partitionFor } from '../src/broker/grants/origin-hash.js'

// `.test` is the IANA-reserved, never-resolvable TLD -- same convention as
// spike/adr7-probe/'s own PROBE_ORIGIN, and it means HERMETIC_RESOLVER's
// blackhole-everything-but-loopback rule and this test agree on the same
// property from two different angles: nothing can ever reach this origin
// except the registered cache handler.
const ORIGIN = 'https://serve-from-cache-e2e.orivon.test'

const APP_JS_BODY = 'window.__fixtureAppRan = true;\n'.padEnd(600, '/* padding for a real Range assertion */ ')
const INDEX_HTML = '<!doctype html><html><head><title>serve-from-cache fixture</title></head>' +
  '<body><h1>serve-from-cache fixture</h1><script src="app.js"></script></body></html>'
const MANIFEST_JSON = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.serve-from-cache-e2e',
  name: 'Serve-from-cache e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js'],
  capabilities: {}
})

/**
 * Writes a real, valid pin plus its assets directly to `userDataDir` --
 * the exact bundleTree()/fromBundleTree() construction install() itself
 * uses (src/loader/index.ts), called here from the test process instead of
 * through a network fetch (this file's own header explains why).
 */
async function pinFixture (userDataDir: string): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(MANIFEST_JSON) },
    { path: '/index.html', content: new TextEncoder().encode(INDEX_HTML) },
    { path: '/app.js', content: new TextEncoder().encode(APP_JS_BODY) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const WAIT_BUDGET_MS =
  8_000 + // initial two-window wait
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + // one navigation
  8_000 + // waitForTab confirmation
  8_000 * 4 + // several evaluateRetrying/waitFor round trips
  8_000 + // teardown: windows -> 0
  APP_CLOSE_RACE_MS
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 20_000

it(
  'a real pin, served through a real registered protocol.handle, loads with no server ever having existed, refuses a planted file, and never leaks onto the default session',
  async () => {
    await runPhase('serve-from-cache', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      try {
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })

        const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
        await pinFixture(userDataDir)

        // ---- Register serving for real, through the dev-only hook --------
        const registerOutcome = await app.evaluate(async (_electron, origin: string) => {
          const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
          if (typeof hook !== 'function') return { hookPresent: false as const }
          await hook(origin)
          return { hookPresent: true as const }
        }, ORIGIN)

        check(
          'the dev-only serve-registration hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
          registerOutcome.hookPresent,
          registerOutcome.hookPresent ? undefined : 'globalThis.__orivonDevRegisterServing was not a function in the main process'
        )
        if (!registerOutcome.hookPresent) throw new Error('dev-serve hook missing -- was this built via npm run test:e2e?')

        const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        check('the shell reaches its launch-time window count', windowsReady)

        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
        const navigated = await waitForTab(chrome, { address: `${ORIGIN}/`, title: 'serve-from-cache fixture' })
        check(
          'navigating to the pinned origin -- which no server has EVER served, over a scheme ' +
          '(https) and TLD (.test) that can never resolve on the real network -- loads anyway: ' +
          'the ONLY thing that could have answered this request is the registered cache handler',
          navigated.ok,
          navigated.ok ? undefined : JSON.stringify(navigated.info)
        )
        if (!navigated.ok) throw new Error('fixture tab failed to navigate against the registered handler')

        const view = findViewShowing(app, chrome, `${ORIGIN}/`)
        check('the navigated tab is identifiable by its own URL', view !== undefined)
        if (view === undefined) throw new Error('no view found showing the pinned origin')

        // ---- Positive control: a genuinely pinned asset serves correctly -
        const appJsFetch = await evaluateRetrying(view, async () => {
          const response = await fetch('/app.js')
          return { status: response.status, body: await response.text(), contentType: response.headers.get('content-type') }
        })
        check(
          'a pinned asset ("/app.js", declared in the manifest\'s own `assets`) is served with status 200 and its exact pinned bytes',
          appJsFetch.status === 200 && appJsFetch.body === APP_JS_BODY,
          JSON.stringify({ status: appJsFetch.status, bodyLength: appJsFetch.body.length })
        )
        check(
          'the served Content-Type is derived from the extension, correctly, not left absent',
          appJsFetch.contentType === 'text/javascript; charset=utf-8',
          String(appJsFetch.contentType)
        )

        // ---- Range requests work (ADR-0007's own probe tested this because a torrent client streams video) --
        const rangedFetch = await evaluateRetrying(view, async () => {
          const response = await fetch('/app.js', { headers: { range: 'bytes=0-4' } })
          return { status: response.status, contentRange: response.headers.get('content-range'), body: await response.text() }
        })
        check(
          'a Range request against a pinned asset returns 206 with the correct slice and Content-Range',
          rangedFetch.status === 206 && rangedFetch.body === APP_JS_BODY.slice(0, 5),
          JSON.stringify(rangedFetch)
        )
        check(
          'the Content-Range header names the correct total length',
          rangedFetch.contentRange === `bytes 0-4/${new TextEncoder().encode(APP_JS_BODY).length}`,
          String(rangedFetch.contentRange)
        )

        // ---- THE FAIL-CLOSED PROOF: a planted file is refused ------------
        // Written directly to the real on-disk code root, from THIS test
        // process, entirely bypassing writeAsset() -- exactly what an
        // out-of-band write to the profile directory would look like. If
        // the registered handler served anything on disk under this
        // origin's code root rather than consulting the pinned set, this
        // file would be reachable.
        const codeRoot = join(userDataDir, 'apps', appRootDirectoryName(ORIGIN), 'code')
        await mkdir(codeRoot, { recursive: true })
        await writeFile(join(codeRoot, 'evil.js'), 'window.__plantedFileRan = true;')

        const plantedFetch = await evaluateRetrying(view, async () => {
          const response = await fetch('/evil.js')
          return { status: response.status, body: await response.text() }
        })
        check(
          'a file planted directly on disk, never part of the pinned manifest, is refused (404) rather ' +
          'than served -- the fail-closed rule ADR-0007 names: "denied, not fetched"',
          plantedFetch.status === 404 && !plantedFetch.body.includes('__plantedFileRan'),
          JSON.stringify(plantedFetch)
        )

        // Independent confirmation the planted bytes really are on disk --
        // if this failed, the check above would be proving nothing.
        const plantedOnDisk = await readFile(join(codeRoot, 'evil.js'), 'utf8')
        check('the planted file genuinely exists on disk at the path the handler would have to read it from', plantedOnDisk.includes('__plantedFileRan'))

        // The pin record itself, one directory up from code/, must never be servable either.
        const pinFetch = await evaluateRetrying(view, async () => (await fetch('/pin.json')).status)
        check('the pin record itself is never reachable through the handler', pinFetch === 404)

        // ---- Partition-scoped, never global (ADR-0007's third property) --
        const partitionScoped = await app.evaluate(({ session }, args: { partition: string, scheme: string }) => {
          return {
            appPartitionHandled: session.fromPartition(args.partition).protocol.isProtocolHandled(args.scheme),
            defaultSessionHandled: session.defaultSession.protocol.isProtocolHandled(args.scheme)
          }
        }, { partition: partitionFor(ORIGIN), scheme: 'https' })
        check('the app\'s own partition genuinely has the handler registered', partitionScoped.appPartitionHandled)
        check(
          'session.defaultSession never received this handler -- serving is scoped to the app\'s own ' +
          'partition, never global (ADR-0007: "a global interception would mean Orivon silently ' +
          'serving stale local bytes for a real website")',
          !partitionScoped.defaultSessionHandled
        )
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
