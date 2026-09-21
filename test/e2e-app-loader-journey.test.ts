// The journey docs/planning/build-plan.md's SS Testing has specified since
// the beginning, and docs/development/testing.md's "The end-to-end test"
// section names as still not fully closed: a fixture app served over real
// localhost HTTP with a real /.well-known/orivon.json -> loaded via the app
// loader -> grant accepted -> require('net') THROUGH THE SHIM connects to a
// local echo server and moves bytes -> then the same app attempts a
// connection outside its manifest patterns and is rejected.
//
// THE HIGHEST-VALUE ASSERTION, BUILT AND VERIFIED FIRST: the out-of-manifest
// refusal below, run through the real shim (src/shim/node-net.ts), not the
// raw capability API test/e2e-capability-boundary.test.ts already covers.
// Without it, nothing fails if capability enforcement degrades to allow-all.
//
// WHAT IS REAL HERE, AND WHAT IS SUBSTITUTED -- READ BEFORE TRUSTING THIS AS
// "the full journey". Four of five links are exercised for real: (1) a real
// page, served over real localhost HTTP by a real node:http server in this
// test process, with a real .well-known/orivon.json; (2) the real discovery
// hint listener -- src/preload/manifest-hint.ts's <link rel="orivon-manifest">
// watcher, wired unconditionally in production (src/main/subsystems.ts),
// reporting over the real MANIFEST_HINT_CHANNEL into src/main/manifest-hint.ts,
// which calls the real, published installApp (src/main/app-install-subsystem.ts)
// -- (3) the real capability check, over the real IPC pipe, denying and
// allowing exactly as production code would; (4) require('net') through the
// REAL, unmodified src/shim/node-net.ts (bundled by esbuild for this fixture,
// see ./app-loader-journey-shim-entry.ts's own header for exactly what that
// substitutes for and why). What is NOT exercised: a real grant reaching that
// pipe via a real, accepted install. src/loader/install-origin.ts's A46 (no
// loopback/non-https carve-out, deliberate, must not be weakened) means
// Loader.load() can never accept ANY hermetic fixture's own origin -- so the
// real hint above is proven to reach the real loader and be correctly
// REFUSED for being non-public, and the granted round trip below is enabled
// instead through src/main/dev-grant.ts's developer-only hook (the same
// substitution test/e2e-capability-boundary.test.ts already makes, and for
// the identical reason), acting on the SAME broker instance the real launched
// shell's real IPC pipe uses. d-0025's own consent-gating logic is proven
// separately, honestly, in ./e2e-install-consent-journey.test.ts, which
// names its own, narrower substitution for the same underlying reason.
//
// TWO PRODUCTION GAPS FOUND WRITING THIS FILE (S4-7-e2e), BOTH CLOSED BY
// S4-X-shimfix: A151, src/shim/globals.ts's installGlobals() had no
// production call site anywhere, so any real app requiring a Node library
// that touches `stream` failed immediately with `process is not defined`
// (this file used to work around it in ./app-loader-journey-shim-entry.ts,
// which called it directly; that workaround is gone -- see this file's own
// registration-before-navigation ordering below for why the fixture's tab
// now gets the same production wiring a real app tab does). A152, the
// refusal checks below used to pin an ACTUAL, currently-wrong error code
// the shim reported for every real denial; they now pin the fixed one.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-app-loader-journey.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo, Server as NetServer, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import esbuild from 'esbuild'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { buildAliasEntries } from '../src/shim/module-map.js'
import type { DevGrantRequest } from '../src/main/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'
import type { ShimRoundTripFailure, ShimRoundTripResult } from './app-loader-journey-shim-entry.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE_APP_ID = 'app.orivon.loader-journey-e2e'

/** electron.vite.config.ts's own renderer alias, generated from the SAME
 * table (src/shim/module-map.ts) -- reused rather than a second hand-picked
 * list, so a shim dependency added there is picked up here automatically
 * (code-guidelines.md Rule 3). A 'local' entry's on-disk file is '.ts'; its
 * import specifier is written '.js' (NodeNext-style, matching every import
 * inside src/shim/ itself) -- electron.vite.config.ts's own comment on the
 * same table documents the identical swap. */
function shimEsbuildAlias (): Record<string, string> {
  const alias: Record<string, string> = {}
  for (const entry of buildAliasEntries()) {
    alias[entry.specifier] = entry.kind === 'package'
      ? entry.implementation
      : join(REPO_ROOT, 'src/shim', entry.implementation.replace(/\.js$/, '.ts'))
  }
  return alias
}

function manifestFor (echoPort: number): Manifest {
  return {
    orivonApiVersion: 0,
    id: FIXTURE_APP_ID,
    name: 'App loader journey e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: ['app-shim-bundle.js'],
    capabilities: { net: { tcp: { connect: [`127.0.0.1:${String(echoPort)}`] } } }
  }
}

function indexHtml (): string {
  return '<!doctype html><html><head><title>app loader journey fixture</title>' +
    '<link rel="orivon-manifest" href="/.well-known/orivon.json">' +
    '</head><body><h1>app loader journey fixture</h1><script src="app-shim-bundle.js"></script></body></html>'
}

let echoServer: NetServer
let echoPort: number
/**
 * A SEPARATE, REAL, LISTENING echo server -- deliberately NOT a port
 * nothing answers on. If it were unreachable, an allow-all regression in
 * checkConnect would still show up here as a REJECTION (the dial itself
 * failing with ECONNREFUSED), which would make this check pass for the
 * wrong reason and prove nothing about policy -- confirmed by actually
 * breaking checkConnect and watching this exact false-pass happen before
 * this server existed (see this PR's own verification output). With a real
 * listener here, checkConnect degrading to allow-all is observable as an
 * actual, successful byte round trip against a capability the manifest
 * never declared -- which is the one thing this file exists to catch.
 */
let outOfManifestServer: NetServer
let outOfManifestPort: number
let staticServer: HttpServer
let staticPort: number
let shimBundleJs: string

beforeAll(async () => {
  echoServer = createNetServer((socket: Socket) => { socket.pipe(socket) })
  await new Promise<void>((resolve) => { echoServer.listen(0, '127.0.0.1', resolve) })
  echoPort = (echoServer.address() as AddressInfo).port

  outOfManifestServer = createNetServer((socket: Socket) => { socket.pipe(socket) })
  await new Promise<void>((resolve) => { outOfManifestServer.listen(0, '127.0.0.1', resolve) })
  outOfManifestPort = (outOfManifestServer.address() as AddressInfo).port

  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('./app-loader-journey-shim-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    write: false,
    absWorkingDir: REPO_ROOT,
    alias: shimEsbuildAlias(),
    logLevel: 'silent'
  })
  const [outputFile] = built.outputFiles
  if (outputFile === undefined) throw new Error('esbuild produced no output for the shim entry')
  shimBundleJs = outputFile.text

  const manifestJson = JSON.stringify(manifestFor(echoPort))
  const html = indexHtml()

  staticServer = createHttpServer((req, res) => {
    if (req.url === '/.well-known/orivon.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(manifestJson)
      return
    }
    if (req.url === '/app-shim-bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(shimBundleJs)
      return
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => { staticServer.listen(0, '127.0.0.1', resolve) })
  staticPort = (staticServer.address() as AddressInfo).port
}, 30_000)

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => { echoServer.close(() => resolve()) }),
    new Promise<void>((resolve) => { outOfManifestServer.close(() => resolve()) }),
    new Promise<void>((resolve) => { staticServer.close(() => resolve()) })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

/** True for the shim entry's own failure shape (app-loader-journey-shim-entry.ts) -- a structural check, not an `instanceof`, since this value crossed page.evaluate()'s structured-clone boundary. */
function isShimFailure (result: ShimRoundTripResult | ShimRoundTripFailure): result is ShimRoundTripFailure {
  return (result as Partial<ShimRoundTripFailure>).rejected === true
}

it(
  'a real page drives require(\'net\') through the real shim: denied with no grant, a granted round trip moves real bytes, an out-of-manifest attempt is refused -- and the real discovery-hint listener is separately observed refusing this http origin',
  async () => {
    await runPhase('app-loader journey', async (check) => {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      // A second listener alongside launchElectron's own stdout forwarder
      // (test/launch-electron.mjs) -- both fire on every 'data' event, so
      // this adds a capture, it does not replace the existing forwarding.
      let mainStdout = ''
      app.process().stdout?.on('data', (chunk: Buffer) => { mainStdout += chunk.toString() })
      try {
        const fixtureOrigin = `http://127.0.0.1:${String(staticPort)}`
        const fixtureUrl = `${fixtureOrigin}/`
        const manifest = manifestFor(echoPort)

        // ---- A151: register this origin BEFORE navigating, granting
        // NOTHING yet -- src/main/tab-view.ts's appTabArgsFor decides,
        // SYNCHRONOUSLY, at WebContentsView construction, whether this
        // tab carries the --orivon-app-tab flag production preload code
        // gates shim-globals installation and fetch routing on, by
        // reading Broker.app.isRegisteredSync -- true the moment a
        // manifest is registered, independent of any grant
        // (net-capability.ts's own connect(): "an empty grant answers
        // exactly like no grant at all"). Registering here, with an EMPTY
        // pattern list, gets this fixture's tab flagged for its very
        // first navigation while keeping tcp.connect denied -- the same
        // grant-before-navigate ordering test/e2e-fetch-routing.test.ts
        // already uses, for the identical reason (a flag fixed at tab
        // construction cannot retroactively apply to an already-created
        // tab; src/preload/README.md's own Design notes name this as a
        // known, permanent limitation of the mechanism, not new here).
        const registerOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: fixtureOrigin, manifest, capability: 'tcp.connect', patterns: [] } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is installed in this build (npm run test:e2e builds with ' +
          'ORIVON_ENABLE_DEV_GRANT=1)',
          registerOutcome.installed,
          registerOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!registerOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        const view = await navigateToFixture(app, fixtureUrl, 'app loader journey fixture')

        // ---- A151, CLOSED: production preload wiring installed the
        // shim's Node globals for THIS tab, not this fixture's own former
        // workaround (see this file's own header, and
        // ./app-loader-journey-shim-entry.ts's) -- proven before the
        // round trips below, which would fail at Duplex construction with
        // `process is not defined` if it had not.
        const globalsInstalled = await view.evaluate(() =>
          typeof (window as unknown as { process?: unknown }).process === 'object')
        check(
          'A151 (docs/open-questions.md), CLOSED: src/preload/expose-shim-globals.ts installs ' +
          'process/setImmediate/clearImmediate onto a real, registered app tab before its own script runs',
          globalsInstalled,
          String(globalsInstalled)
        )

        // ---- the real discovery-hint listener, observed for real --------
        // Fires automatically on load (src/preload/app.ts's fallback branch
        // calls installManifestHintWatcher() unconditionally) -- no action
        // from this test triggers it. installFromHint's own same-origin
        // check passes (this http origin matches its own hint), so the
        // rejection below is install-origin.ts's A46 (https/public-unicast
        // only, no exception) refusing the loader's own fetch, not an
        // earlier, less meaningful failure.
        const hintRejected = await waitFor(
          () => mainStdout.includes(`manifest hint from ${fixtureOrigin} did not install: rejected`),
          10_000
        )
        check(
          'the real <link rel="orivon-manifest"> hint reaches the real, production-wired discovery ' +
          'listener (preload manifest-hint.ts -> main manifest-hint.ts -> the real installFromHint), ' +
          'and is refused -- A46 has no loopback/non-https carve-out, so this http origin can never ' +
          'complete a real install through this path (see this file\'s header)',
          hintRejected,
          hintRejected ? undefined : `stdout so far: ${mainStdout}`
        )

        // ---- denied before any grant, through the real shim --------------
        const beforeGrant = await view.evaluate(async (args: { host: string, port: number }) => {
          const fn = (window as unknown as { __orivonShimRoundTrip?: (h: string, p: number, m: string) => Promise<ShimRoundTripResult | ShimRoundTripFailure> }).__orivonShimRoundTrip
          if (typeof fn !== 'function') return { rejected: true as const, name: 'missing-hook', code: '', orivonCode: '', message: 'window.__orivonShimRoundTrip is not a function' }
          return await fn(args.host, args.port, 'pre-grant probe')
        }, { host: '127.0.0.1', port: echoPort })
        check(
          'before any grant exists, a real connect() through the ACTUAL SHIM (require(\'net\'), not the ' +
          'raw capability API) is REFUSED -- not a hang, not a silent success. This is the security-' +
          'relevant property: an allow-all regression would make this resolve instead of reject',
          isShimFailure(beforeGrant),
          JSON.stringify(beforeGrant)
        )
        check(
          'A152 (docs/open-questions.md), CLOSED: the shim reports this refusal as `denied`, its real ' +
          'code -- previously the generic `internal` fallback, because the RAW window.orivon.net.connect() ' +
          'rejection is a plain {name, message, code} object once it has crossed back from the main world ' +
          'to the page, correctly shaped but never `instanceof Error`, and src/shim/node-http-errors.ts\'s ' +
          'isOrivonError() used to require exactly that. It is now structural (still validated against ' +
          'the closed OrivonErrorCode enum, so a malformed value still fails closed to `internal`), and ' +
          'src/preload/main-world-socket.ts also revives the crossed value into a real Error before the ' +
          'page ever sees it, restoring `OrivonError extends Error` for every consumer, not just this shim',
          isShimFailure(beforeGrant) && beforeGrant.orivonCode === 'denied',
          JSON.stringify(beforeGrant)
        )

        // ---- grant the real capability, through the same dev-only hook --
        // registerApp is safe to call again (installDevGrantHook's own
        // doc); this replaces the empty-pattern grant made before
        // navigation with the real one, on the SAME broker the real IPC
        // pipe above is wired to (this file's header explains why this
        // substitution, not a real install, is what enables this).
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: fixtureOrigin, manifest, capability: 'tcp.connect', patterns: [`127.0.0.1:${String(echoPort)}`] } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is still installed for the real-capability grant',
          grantOutcome.installed,
          grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        // ---- assertion 2: a granted round trip, through the real shim ----
        const granted = await view.evaluate(async (args: { host: string, port: number }) => {
          const fn = (window as unknown as { __orivonShimRoundTrip?: (h: string, p: number, m: string) => Promise<ShimRoundTripResult | ShimRoundTripFailure> }).__orivonShimRoundTrip
          if (typeof fn !== 'function') return { rejected: true as const, name: 'missing-hook', code: '', orivonCode: '', message: 'window.__orivonShimRoundTrip is not a function' }
          return await fn(args.host, args.port, `journey round trip ${new Date().toISOString()}`)
        }, { host: '127.0.0.1', port: echoPort })
        check(
          'ASSERTION 2 -- a granted connection, made through require(\'net\') AS PRESENTED BY THE REAL ' +
          'orivon-node-shim (not the raw WHATWG-stream capability API), dials the real echo server and ' +
          'round-trips the exact bytes sent',
          !isShimFailure(granted) && granted.received === granted.sent,
          JSON.stringify(granted)
        )

        // ---- ASSERTION 1, THE POINT OF THIS FILE: out-of-manifest denial -
        // outOfManifestPort has a REAL listener (see its own declaration
        // above for why that matters) -- an allow-all regression here would
        // show up as an actual successful round trip, not a coincidental
        // dial failure against a silent port.
        const denied = await view.evaluate(async (args: { host: string, port: number }) => {
          const fn = (window as unknown as { __orivonShimRoundTrip?: (h: string, p: number, m: string) => Promise<ShimRoundTripResult | ShimRoundTripFailure> }).__orivonShimRoundTrip
          if (typeof fn !== 'function') return { rejected: true as const, name: 'missing-hook', code: '', orivonCode: '', message: 'window.__orivonShimRoundTrip is not a function' }
          return await fn(args.host, args.port, 'out-of-manifest probe')
        }, { host: '127.0.0.1', port: outOfManifestPort })
        check(
          'ASSERTION 1, THE HIGHEST-VALUE CHECK IN THIS FILE -- the SAME app, holding a real grant for ' +
          'a DIFFERENT, REAL, LISTENING server, attempts a connection outside its manifest patterns ' +
          'through require(\'net\') and is REFUSED -- not a timeout, not a hang, not a silent success, ' +
          'and specifically not merely a dial failure against a silent port (this server really answers, ' +
          'see its own declaration above). A broker regression that degraded to allow-all would pass ' +
          'every other assertion above and show up ONLY here, as an actual successful round trip.',
          isShimFailure(denied),
          JSON.stringify(denied)
        )
        check(
          'A152, CLOSED, applies here too: the refusal is real, and its reported code is `denied`, the ' +
          'same as the before-grant check above, for the identical reason',
          isShimFailure(denied) && denied.orivonCode === 'denied',
          JSON.stringify(denied)
        )
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
