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
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './support/launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, findChrome, findViewShowing, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './support/e2e-helpers.js'
import { DEFAULT_ACTION_TIMEOUT_MS } from './support/launch-electron.mjs'
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

// An ORDINARY page, on a real loopback server, that links to the pinned
// app's origin -- for the shift-click regression below: routePopup's isApp
// check returns 'new-tab' for a cross-origin app target from a page that is
// not itself the app (before disposition is ever weighed), so a shift-click
// there needs its own carve-out to still open a window, not a tab.
const ORDINARY_HOST = '127.0.0.1'
const ORDINARY_PORT = 8945
const ORDINARY_ORIGIN = `http://${ORDINARY_HOST}:${ORDINARY_PORT}`
const ORDINARY_PAGE = `<!doctype html><meta charset="utf-8"><title>ordinary page</title><body>
<a id="to-app" href="${ORIGIN}/">the pinned app</a>
</body>`
let ordinaryServer: Server

const APP_JS_BODY = 'window.__fixtureAppRan = true;\n'.padEnd(600, '/* padding for a real Range assertion */ ')
// A separate asset, not an inline <script>: the pinned app's own served CSP (ADR-0007) has no
// 'unsafe-inline', same as any real app's.
const BLOB_JS_BODY = "const blob = new Blob(['<title>serve-from-cache blob</title>blob content'], { type: 'text/html' });\n" +
  "document.getElementById('blob-link').href = URL.createObjectURL(blob)\n"
// A same-origin link, a data: link and a blob: link (minted at load, its own origin the same as
// this page's), for the middle-click regressions below: a middle click inside this pinned app
// must land the new tab in the SAME pinned partition (never session.defaultSession), a middle
// click on a dangerous scheme must never render it, and a middle click on the app's own blob:
// must still show the blob's content, in that same pinned partition -- never about:blank.
const INDEX_HTML = '<!doctype html><html><head><title>serve-from-cache fixture</title></head>' +
  '<body><h1>serve-from-cache fixture</h1><script src="app.js"></script>' +
  '<a id="same-origin" href="/other.html">other</a>' +
  '<a id="data-link" href="data:text/html,should-not-render">data</a>' +
  '<a id="blob-link">blob</a>' +
  '<script src="blob.js"></script>' + // after the anchor it fills in: a page's own script order
  '</body></html>'
const OTHER_HTML = '<!doctype html><html><head><title>serve-from-cache other</title></head><body>other</body></html>'
const MANIFEST_JSON = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.serve-from-cache-e2e',
  name: 'Serve-from-cache e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'other.html', 'blob.js'],
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
    { path: '/app.js', content: new TextEncoder().encode(APP_JS_BODY) },
    { path: '/other.html', content: new TextEncoder().encode(OTHER_HTML) },
    { path: '/blob.js', content: new TextEncoder().encode(BLOB_JS_BODY) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
}

/** Launches, pins the fixture and registers it for real through the dev-only
 * serve hook -- the shared setup both tests in this file need, factored out
 * once a second test needed it too. Throws if the hook is missing (a build
 * not made via `npm run test:e2e`). */
async function launchWithFixtureServed (): Promise<{ app: Awaited<ReturnType<typeof launchElectron>>, userDataDir: string }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, '--alsa-output-device=null'],
    env: { PULSE_SERVER: 'unix:/nonexistent' }
  })
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  await pinFixture(userDataDir)
  const hookPresent = await app.evaluate(async (_electron, origin: string) => {
    const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
    if (typeof hook !== 'function') return false
    await hook(origin)
    return true
  }, ORIGIN)
  if (!hookPresent) throw new Error('dev-serve hook missing -- was this built via npm run test:e2e?')
  return { app, userDataDir }
}

beforeAll(async () => {
  ordinaryServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(ORDINARY_PAGE)
  })
  await new Promise<void>((resolve) => { ordinaryServer.listen(ORDINARY_PORT, ORDINARY_HOST, resolve) })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { ordinaryServer.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Every chrome (shell) view in `app`, one per window -- e2e-multi-window.test.ts's own pattern. */
function chromePages (app: ElectronApplication): Page[] {
  return app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
}

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
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER, '--alsa-output-device=null'],
          env: { PULSE_SERVER: 'unix:/nonexistent' }
        })

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

it(
  'a middle click on a same-origin link inside this pinned app opens its new tab in the SAME app ' +
  'partition, never session.defaultSession; a middle click on a data: link never renders it; and a ' +
  'middle click on the app\'s own blob: link still shows its content, in that same partition',
  async () => {
    await runPhase('serve-from-cache-middle-click', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      try {
        ({ app } = await launchWithFixtureServed())

        const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        check('the shell reaches its launch-time window count', windowsReady)

        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
        const navigated = await waitForTab(chrome, { address: `${ORIGIN}/`, title: 'serve-from-cache fixture' })
        check('the pinned origin loads through the registered handler', navigated.ok, navigated.ok ? undefined : JSON.stringify(navigated.info))
        if (!navigated.ok) throw new Error('fixture tab failed to navigate')

        const view = findViewShowing(app, chrome, `${ORIGIN}/`)
        check('the navigated tab is identifiable by its own URL', view !== undefined)
        if (view === undefined) throw new Error('no view found showing the pinned origin')

        // ---- THE HIGH DEFECT THIS GUARDS ---------------------------------
        // A middle click never carries a guest webContents to adopt
        // (popups.ts's guestOf), and this app's own partition equals its
        // opener's (routePopup's 'adopt'), which used to skip the ordinary
        // tab pipeline entirely and build an unpartitioned view instead --
        // landing this same-origin, network-served page in
        // session.defaultSession with the app's own grants still attached
        // (T6/T18/T21).
        const before = await tabIds(chrome)
        await view.click('#same-origin', { button: 'middle' })
        check('the middle click opened a new tab', await waitFor(async () => (await tabIds(chrome)).length > before.length))

        // A background tab's view is never attached to any window (it stays
        // detached until activated), so it never shows up walking a
        // BaseWindow's own contentView -- getAllWebContents() finds it by
        // its committed URL regardless of attachment.
        const otherUrl = `${ORIGIN}/other.html`
        check('the new tab actually loaded the pinned /other.html, through the same registered handler',
          await waitFor(async () => await (app as NonNullable<typeof app>).evaluate(({ webContents }, url: string) => {
            return webContents.getAllWebContents().some((c) => c.getURL() === url)
          }, otherUrl)))

        const partitionCheck = await app.evaluate(({ webContents, session }, args: { url: string, partition: string }) => {
          const wc = webContents.getAllWebContents().find((c) => c.getURL() === args.url)
          return {
            found: wc !== undefined,
            samePartition: wc?.session === session.fromPartition(args.partition),
            isDefaultSession: wc?.session === session.defaultSession
          }
        }, { url: otherUrl, partition: partitionFor(ORIGIN) })
        check('the new tab was found by its committed URL', partitionCheck.found)
        check('the new tab runs in the app\'s own partition, not a fresh unpartitioned view', partitionCheck.samePartition, JSON.stringify(partitionCheck))
        check('the new tab is never session.defaultSession', !partitionCheck.isDefaultSession)

        // ---- LOW: a middle click on a dangerous scheme never renders it --
        // Measured: Chromium's own top-frame data: URL restriction refuses
        // the whole attempt before it ever reaches setWindowOpenHandler, so
        // no new tab appears at all here -- stronger than sanitizeDirectUrl
        // mapping it to about:blank, which is what would happen instead if
        // this ever did reach our handler (a script-driven window.open() to
        // a data: URL, unlike a link click, is not subject to that Chromium
        // restriction). Either way, the one property that must hold: the
        // data: page never renders, in this tab or a new one.
        await view.click('#data-link', { button: 'middle' }).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const dataRendered = await app.evaluate(({ webContents }) => {
          return webContents.getAllWebContents().some((c) => c.getURL().startsWith('data:'))
        })
        check('a middle click on a data: link never renders it, whatever Chromium or sanitizeDirectUrl does with the attempt', !dataRendered)

        // ---- LOW: a same-origin blob: still opens, in the app's own partition ------------------
        // The ordinary tab pipeline (sanitizeDirectUrl) refuses blob: outright, landing it on
        // about:blank -- this app's own blob is the one URL a no-guest open can safely show
        // instead, in the OPENER's partition (blobMintedByOpener's own doc): a blob: registration
        // lives in a session's own store, resolvable there and nowhere else.
        const blobUrl = await evaluateRetrying(view, () => (document.getElementById('blob-link') as HTMLAnchorElement).href)
        check('the app minted a real blob: URL of its own', blobUrl.startsWith('blob:'))
        const beforeBlob = await tabIds(chrome)
        await view.click('#blob-link', { button: 'middle' })
        check('the middle click on the blob: link opened a new tab', await waitFor(async () => (await tabIds(chrome)).length > beforeBlob.length))
        const blobFound = await waitFor(async () => await (app as NonNullable<typeof app>).evaluate(({ webContents }, url: string) => {
          return webContents.getAllWebContents().some((c) => c.getURL() === url)
        }, blobUrl))
        check('the blob: tab was found by its committed URL', blobFound)
        const blobCheck = await app.evaluate(({ webContents, session }, args: { url: string, partition: string }) => {
          const wc = webContents.getAllWebContents().find((c) => c.getURL() === args.url)
          return { found: wc !== undefined, title: wc?.getTitle(), samePartition: wc?.session === session.fromPartition(args.partition) }
        }, { url: blobUrl, partition: partitionFor(ORIGIN) })
        check('the blob: tab shows the blob\'s own content, not about:blank', blobCheck.title === 'serve-from-cache blob', JSON.stringify(blobCheck))
        check('the blob: tab runs in the app\'s own partition', blobCheck.samePartition, JSON.stringify(blobCheck))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)

it(
  'a shift-click on the pinned app\'s origin, from an ordinary page that is not itself the app, ' +
  'still opens a new window rather than a tab',
  async () => {
    await runPhase('serve-from-cache-shift-click', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      try {
        ({ app } = await launchWithFixtureServed())

        const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        check('the shell reaches its launch-time window count', windowsReady)

        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORDINARY_ORIGIN}/`)
        const navigated = await waitForTab(chrome, { address: `${ORDINARY_ORIGIN}/`, title: 'ordinary page' })
        check('the ordinary (unpinned) page loads over a real loopback server', navigated.ok, navigated.ok ? undefined : JSON.stringify(navigated.info))
        if (!navigated.ok) throw new Error('ordinary fixture tab failed to navigate')

        const view = findViewShowing(app, chrome, `${ORDINARY_ORIGIN}/`)
        check('the ordinary tab is identifiable by its own URL', view !== undefined)
        if (view === undefined) throw new Error('no view found showing the ordinary page')
        const ordinaryTabsBefore = await tabIds(chrome)

        // routePopup's isApp check returns 'new-tab' for this cross-origin app
        // target before disposition is ever weighed -- the carve-out this
        // guards sends a shift-click there to a window anyway.
        await view.click('#to-app', { modifiers: ['Shift'] })

        check('a new window opens', await waitFor(() => chromePages(app as NonNullable<typeof app>).length === 2))
        const second = chromePages(app).find((page) => page !== chrome)
        check('the new window\'s chrome view appeared', second !== undefined)
        if (second === undefined) throw new Error('the new window\'s chrome view did not appear')
        const secondNavigated = await waitForTab(second, { address: `${ORIGIN}/`, title: 'serve-from-cache fixture' })
        check(
          'the new window\'s own tab loads the pinned app, through the registered handler, not a tab in the first window',
          secondNavigated.ok,
          secondNavigated.ok ? undefined : JSON.stringify(secondNavigated.info)
        )
        check('the ordinary window\'s own tabs are unchanged', JSON.stringify(await tabIds(chrome)) === JSON.stringify(ordinaryTabsBefore))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
