// A143 (docs/open-questions.md), owner decision 2026-09-14: an app may now
// reach a third-party host it holds a live `https.connect` grant for, from
// inside its own partition -- src/loader/serve.ts's `fetchThirdParty`,
// wired to the real network via src/loader/serve-reach.ts's `nodeReachDial`.
//
// WHY THIS CANNOT PROVE A COMPLETED BYTE ROUND TRIP OVER TLS, AND WHY THAT
// IS NOT A GAP HERE EITHER. `test/e2e-connect-secure-capability.test.ts`'s
// own header already establishes this for `orivon.net.connectSecure`:
// "there is no hermetic way to hand a locally launched, unmodified
// production build a certificate it will actually trust" -- `nodeReachDial`
// has the identical property on purpose (`serve-reach.ts`'s own header:
// production wiring supplies no `ca`, trusting only the runtime's real root
// store). `src/loader/tests/serve-reach.test.ts` already proves a REAL byte
// round trip over a REAL TLS handshake, using the SAME testing-only `ca`
// seam `tls-adapter.ts` established -- that is the layer where trust can be
// legitimately overridden for a test. What THIS file proves instead, and it
// is a real, meaningful, end-to-end assertion rather than a consolation
// prize (same framing as e2e-connect-secure-capability.test.ts's own): a
// real page's real request to a GRANTED host reaches a REAL local server's
// REAL TCP accept -- proving the whole pipeline (CSP widened, the live
// `https.connect` gate said yes, `nodeReachDial` genuinely dialled) -- while
// an UNGRANTED host, with an identical real server listening and ready,
// NEVER sees a connection at all. It is checked with a REAL LOCAL SERVER on
// both sides, not "nothing was listening" on the denied side, which would
// prove nothing about why the gate refused it.
//
// WHAT THE UNGRANTED-HOST CHECK ACTUALLY PROVES, MEASURED RATHER THAN
// ASSUMED. `img-src`/`font-src`/`media-src` are derived from the SAME live
// `https.connect` grant `fetchThirdParty`'s own `authoriseReach` checks
// (`connect-src.ts`'s `appReachCspHeaderValue`, `electron-serve.ts`'s
// `secureHeaderPatternsFor`) -- so in ordinary operation an ungranted host
// is refused TWICE, by CSP first (the browser never even attempts the
// request) and by `fetchThirdParty` second, and this file's own real-server
// signal cannot tell which one actually stopped it. Confirmed by direct
// experiment, not assumed: temporarily disabling `fetchThirdParty`'s own
// `if (!decision.allowed) return denyResponse(...)` guard left THIS file's
// ungranted-host check passing unchanged (CSP alone already refuses the
// attempt) -- so this file is not, by itself, the broken-gate proof for
// `fetchThirdParty`'s own authorisation logic. `src/loader/tests/
// serve.test.ts`'s own "THE BROKEN-GATE PROOF" test is: it constructs the
// `Request` directly, bypassing CSP entirely (there is no browser in a unit
// test), and DOES fail against that same disabled guard -- verified the
// same way, by disabling it and watching that test fail before restoring
// it. What THIS file proves that the unit test cannot: the two independent
// layers (CSP, and the live handler underneath it) actually agree in a
// real, unmodified build, and the granted path genuinely reaches the real
// network end to end.
//
// PORTS ARE LITERAL, NOT CLOSED OVER, same reason as `e2e-fetch-routing.
// test.ts`'s own header: a value closed over from outside an
// evaluateRetrying callback does not survive Playwright's own
// serialisation. 8881/8882, distinct from every port already used
// elsewhere in this suite (8872/8873/8875/8876/8877/8879/8880).
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-third-party-reach.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:tls'
import type { Server } from 'node:tls'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/node-storage.js'
import { generateTlsFixture } from '../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://third-party-reach-e2e.orivon.test'
const GRANTED_PORT = 8881
const UNGRANTED_PORT = 8882
const GRANT_PATTERN = `localhost:${String(GRANTED_PORT)}`

const INDEX_HTML = '<!doctype html><html><head><title>third-party-reach fixture</title></head><body><h1>reach fixture</h1></body></html>'
const MANIFEST_JSON = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.third-party-reach-e2e',
  name: 'Third-party reach e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: {}
})

/** Same construction install() itself uses -- install-origin.ts's https/public-unicast-only rule has no exception a hermetic `.test` origin could ever satisfy, same reasoning as e2e-csp-connect-src.test.ts's own `pinFixture`. */
async function pinFixture (userDataDir: string): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(MANIFEST_JSON) },
    { path: '/index.html', content: new TextEncoder().encode(INDEX_HTML) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
}

/**
 * A real `node:tls` server with a real, freshly generated (self-signed)
 * certificate -- `connection` fires on the raw TCP accept, BEFORE and
 * independently of whether the TLS handshake that follows succeeds, so it
 * is the right signal for "a real dial was attempted" regardless of cert
 * trust (measured directly against Node's own tls.Server, not assumed).
 *
 * `resetCount` exists because `waitForTcpReady` (e2e-helpers.ts) below
 * makes its OWN real TCP connection, from this test's own Node process, to
 * confirm the server is actually listening before the browser-driven part
 * of this test begins -- that connection is real and expected, but it is
 * not one this test means to prove anything about, so it must not be
 * counted as if the PAGE had caused it (found by this test's own first
 * run: the ungranted-host check failed with connectionCount=1 before this
 * reset existed, from exactly that readiness probe).
 */
function realTlsServer (): { server: Server, connectionCount: () => number, resetCount: () => void } {
  let connections = 0
  const fixture = generateTlsFixture()
  const server = createServer({ key: fixture.leafKey, cert: fixture.leafCert })
  server.on('connection', () => { connections += 1 })
  // A handshake that fails (untrusted cert, this fixture's CA is never
  // installed anywhere) still raises 'tlsClientError' on the server side --
  // swallowed here rather than left to crash the process; it is expected on
  // every real attempt below, not a bug in this fixture.
  server.on('tlsClientError', () => {})
  return { server, connectionCount: () => connections, resetCount: () => { connections = 0 } }
}

let grantedServer: ReturnType<typeof realTlsServer>
let ungrantedServer: ReturnType<typeof realTlsServer>

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => { grantedServer.server.close(() => resolve()) }),
    new Promise<void>((resolve) => { ungrantedServer.server.close(() => resolve()) })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

it(
  'a real page in a real app partition reaching a GRANTED host causes a real dial attempt (a real server sees a real TCP connection); ' +
  'an UNGRANTED host -- with an identical real server listening -- never does',
  async () => {
    grantedServer = realTlsServer()
    ungrantedServer = realTlsServer()
    await Promise.all([
      new Promise<void>((resolve) => { grantedServer.server.listen(GRANTED_PORT, '127.0.0.1', resolve) }),
      new Promise<void>((resolve) => { ungrantedServer.server.listen(UNGRANTED_PORT, '127.0.0.1', resolve) }),
      waitForTcpReady('127.0.0.1', GRANTED_PORT, 10_000),
      waitForTcpReady('127.0.0.1', UNGRANTED_PORT, 10_000)
    ])
    // See realTlsServer's own doc: the readiness probe just above is a
    // real connection this test does not mean to count.
    grantedServer.resetCount()
    ungrantedServer.resetCount()

    await runPhase('third-party reach (A143)', async (check) => {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
        await pinFixture(userDataDir)

        const manifest: Manifest = {
          orivonApiVersion: 0,
          id: 'app.orivon.third-party-reach-e2e',
          name: 'Third-party reach e2e fixture',
          version: '1.0.0',
          entry: 'index.html',
          capabilities: { net: { https: { connect: [GRANT_PATTERN] } } }
        }
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: ORIGIN, manifest, capability: 'https.connect', patterns: [GRANT_PATTERN] } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
          grantOutcome.installed,
          grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        const registerOutcome = await app.evaluate(async (_electron, origin: string) => {
          const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
          if (typeof hook !== 'function') return { hookPresent: false as const }
          await hook(origin)
          return { hookPresent: true as const }
        }, ORIGIN)
        check(
          'the dev-only serve-registration hook is installed in this build',
          registerOutcome.hookPresent,
          registerOutcome.hookPresent ? undefined : 'globalThis.__orivonDevRegisterServing was not a function in the main process'
        )
        if (!registerOutcome.hookPresent) throw new Error('dev-serve hook missing -- was this built via npm run test:e2e?')

        const view = await navigateToFixture(app, `${ORIGIN}/`, 'third-party-reach fixture')

        // ---- The header itself widened img-src/font-src/media-src from
        // the granted https.connect pattern (A143), never from tcp.connect ----
        const cspHeader = await evaluateRetrying(view, async () => (await fetch('/')).headers.get('content-security-policy'))
        check(
          'the served document\'s own response widens img-src/font-src/media-src to the granted host, from https.connect',
          typeof cspHeader === 'string' && cspHeader.includes('img-src \'self\' localhost:8881; font-src \'self\' localhost:8881; media-src \'self\' localhost:8881'),
          String(cspHeader)
        )

        // ---- THE ENFORCEMENT PROOF: a real XHR to the GRANTED host, and
        // one to an UNGRANTED host with an equally real server listening.
        // No reference to outer consts inside this callback -- see file
        // header, same constraint fetch-route.ts's own installFetchRoute
        // and e2e-csp-connect-src.test.ts's own evaluate callback share.
        // AN <img> ELEMENT, NOT AN XHR: `img-src`/`font-src`/`media-src` are
        // what this PR actually widens (this file's own earlier check,
        // above) -- `connect-src` is sourced from `tcp.connect` alone, a
        // SEPARATE grant this fixture never holds (A143/ADR-0017's own
        // split), unaffected by whether A158's restart-hydration gap is
        // open or closed, so an XHR here would be refused by CSP's
        // `connect-src` before ever reaching `fetchThirdParty` at
        // all, proving nothing about img-src. (Found running this file the
        // first time: both XHRs settled with `status: 0` and NEITHER real
        // server saw a connection -- a CSP-level refusal, not a policy
        // decision -- which is why this uses the directive this PR
        // actually governs instead.)
        const result = await evaluateRetrying(view, async () => {
          function loadImage (url: string): Promise<{ settled: boolean, loaded: boolean }> {
            return new Promise((resolve) => {
              const img = new Image()
              img.onload = () => { resolve({ settled: true, loaded: true }) }
              img.onerror = () => { resolve({ settled: true, loaded: false }) }
              img.src = url
            })
          }
          const granted = await loadImage('https://localhost:8881/x.png')
          const ungranted = await loadImage('https://localhost:8882/x.png')
          return { granted, ungranted }
        }, 15_000)

        // Neither ever loads as a real image (the real servers below answer
        // no HTTP at all, and the granted one fails its TLS handshake
        // regardless) -- the check below is NOT about `loaded`, it is about
        // which real server actually saw a connection.
        check('both <img> loads settled (neither hung)', result.granted.settled && result.ungranted.settled, JSON.stringify(result))

        // Give the main process a moment: the dial and the TLS handshake
        // failure both happen asynchronously after fetchThirdParty already
        // answered the page's XHR.
        await new Promise((resolve) => setTimeout(resolve, 300))

        check(
          'THE PROOF: the GRANTED host\'s real server saw a real TCP connection -- fetchThirdParty genuinely authorised and dialled it',
          grantedServer.connectionCount() > 0,
          `connectionCount=${String(grantedServer.connectionCount())}`
        )
        check(
          'the UNGRANTED host\'s real, listening server saw NO connection at all (CSP and fetchThirdParty agreeing to refuse it in a real build -- see this file\'s own header for which of the two this alone does and does not prove)',
          ungrantedServer.connectionCount() === 0,
          `connectionCount=${String(ungrantedServer.connectionCount())}`
        )
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
