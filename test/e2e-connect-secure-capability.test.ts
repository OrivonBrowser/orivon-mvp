// The net.connectSecure half of the end-to-end capability test, in its own
// file for the reason ./e2e-udp-capability.test.ts's own header gives:
// ./e2e-capability-boundary.test.ts is already a whole suite and Rule 2 caps
// a test file at 800 lines. Shares ./e2e-helpers.ts.
//
// WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// Phase 1 mirrors e2e-capability-boundary.test.ts's own Phase 1 exactly, for
// net.connectSecure instead of net.connect: the real shell launches, a real
// page has a real window.orivon.net.connectSecure function, a real call
// through it reaches the real broker's real policy check over real Electron
// IPC, and comes back 'denied' -- because nothing grants a production origin
// anything until build step 4's permission prompt exists. Same honest
// position as every other capability e2e in this repo.
//
// Phase 2 grants https.connect through src/main/dev-grant.ts's hook, on the
// SAME broker instance the real launched app's real IPC is wired to (via
// Playwright's ElectronApplication.evaluate(), never via window.orivon) --
// exactly e2e-capability-boundary.test.ts's own Phase 2 pattern, not
// e2e-udp-capability.test.ts's (that file's Phase 2 deliberately uses a
// second, disconnected Broker; this one does not, because proving
// net.connectSecure reaches the real IPC pipe under a grant is the whole
// point here). Two calls, from the real page:
//
//   (a) OUTSIDE the granted pattern -- denied by POLICY alone, before any
//       dial, proving a real page's grant check runs for connectSecure too.
//   (b) INSIDE the granted pattern, against a REAL local node:tls server
//       with a REAL, freshly generated certificate -- reaching the REAL
//       node:tls handshake and REAL certificate verification (ADR-0017),
//       refused as 'unreachable' with a real platformCode.
//
// (b) is NOT a successful byte round trip, and that is not a gap in this
// file -- it is what ADR-0017 and src/broker/adapters/tls-adapter.ts's own
// header deliberately make impossible to fake hermetically. `dialTls` (the
// production export `brokerIpcSubsystem` wires in, unconditionally, with no
// override) is exactly `createDialTls()` with no `ca` argument: it trusts
// ONLY the runtime's real default certificate store. `createDialTls({ ca })`
// is a TESTING SEAM that nothing between an app and that file can ever reach
// -- not net-capability.ts, not a grant, not a manifest -- so there is no
// hermetic way to hand a locally launched, unmodified production build a
// certificate it will actually trust. Proving a granted byte round trip
// would need either weakening that trust store for a real launch (the exact
// security property ADR-0017 rests on -- this lane will not do that) or a
// real public host over the open internet (non-hermetic). What (b) proves
// instead -- a real, meaningful, end-to-end assertion, not a consolation
// prize -- is that a grant issued on the real broker reaches connectSecure's
// real policy check AND its real node:tls dial AND real certificate
// verification, all over the real Electron IPC pipe Phase 1 shows correctly
// denies without one, and that the resulting denial crosses contextBridge
// back into the page with `code`/`name`/`platformCode` intact (this lane's
// own "a thrown custom error loses its `code` crossing contextBridge"
// finding, proven here for the async net path's own denial).
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:tls'
import type { Server } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import { generateTlsFixture } from '../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import type { DevGrantRequest } from '../src/main/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

// fileURLToPath on a directory URL keeps the trailing separator (the same
// gotcha e2e-capability-boundary.test.ts's own header documents) -- stripped
// here so join(FIXTURE_DIR, 'serve.mjs') points inside apps/fixture/, not
// apps/.
const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`

/**
 * A FIXED port, not an ephemeral one bound at runtime -- deliberately, the
 * same choice apps/fixture/config.mjs's ECHO_PORT and
 * e2e-udp-capability.test.ts's UDP_ECHO_PORT already make. `evaluateRetrying`
 * calls `page.evaluate(fn)` with no argument channel of its own, and a value
 * closed over from outside `fn` does not survive Playwright's own
 * serialisation boundary (e2e-capability-boundary.test.ts's Phase 2 makes the
 * identical point about `app.evaluate`) -- so the port has to be a literal
 * INSIDE each evaluate() callback below, which only works if it is known
 * ahead of time. Distinct from every other fixture port already in use
 * (8872/8873/8875/8876) so a stray leftover process from another suite is
 * never mistaken for this one.
 */
const TLS_PORT = 8877

/** Long enough for a real launch, a real page load, and a handful of real IPC round trips -- no address-bar navigation dance of its own to budget for beyond navigateToFixture's own bounded waits. */
const TEST_TIMEOUT_MS = 120_000

let staticServer: ChildProcess
let tlsServer: Server

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)

  // A real TLS server, a real freshly generated certificate -- generateTlsFixture
  // shells out to openssl once per file, same as tls-adapter.test.ts's own
  // beforeAll. Its leaf's SAN is DNS:localhost only (the helper's own header),
  // which is why Phase 2 below dials 'localhost', not '127.0.0.1' -- matching
  // tls-adapter.test.ts's own precedent for the same certificate shape.
  const fixture = generateTlsFixture()
  tlsServer = createServer({ key: fixture.leafKey, cert: fixture.leafCert }, (socket) => {
    socket.end('hello from the real server')
  })
  await Promise.all([
    new Promise<void>((resolve) => { tlsServer.listen(TLS_PORT, '127.0.0.1', resolve) }),
    waitForTcpReady(HOST, STATIC_PORT, 10_000)
  ])
}, 15_000)

afterAll(async () => {
  await Promise.all([
    killChild(staticServer),
    new Promise<void>((resolve) => { tlsServer.close(() => resolve()) })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const GRANT_DENIAL_MESSAGE = 'https.connect is not granted to this origin'

it('Phase 1: a real net.connectSecure through the full IPC pipe is correctly denied (no grant exists)', async () => {
  await runPhase('Phase 1 (connectSecure)', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

      const state = await evaluateRetrying(view, async () => {
        const orivon = (window as unknown as {
          orivon: {
            net: { connectSecure: (o: { host: string, port: number }) => Promise<{ close?: () => Promise<void> } | undefined> }
          }
        }).orivon

        let netConnectSecureIsThenable = false
        let netConnectSecureError
        try {
          // No real server needs to be listening here -- checkConnectSecure
          // denies for want of a grant before any dial is attempted, exactly
          // as e2e-capability-boundary.test.ts's own Phase 1 does for
          // net.connect.
          const pending = orivon.net.connectSecure({ host: 'localhost', port: 44399 })
          netConnectSecureIsThenable = typeof (pending as unknown as { then?: unknown })?.then === 'function'
          const socket = await pending
          await socket?.close?.()
        } catch (e) {
          const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
          netConnectSecureError = { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
        }

        return {
          hasOrivonNetConnectSecure: typeof (window as unknown as {
            orivon?: { net?: { connectSecure?: unknown } }
          }).orivon?.net?.connectSecure,
          netConnectSecureIsThenable,
          netConnectSecureError
        }
      })

      check(
        'window.orivon.net.connectSecure IS a callable function, not merely a truthy placeholder',
        state.hasOrivonNetConnectSecure === 'function',
        JSON.stringify(state)
      )
      check(
        'orivon.net.connectSecure() returns a real thenable synchronously, before any rejection -- ' +
        'not a synchronous throw, which would break every `.catch()`-based caller',
        state.netConnectSecureIsThenable,
        JSON.stringify(state)
      )
      check(
        'a real net.connectSecure through the full IPC pipe is denied with a real, correctly-shaped ' +
        'OrivonError -- not a timeout, a crash, or a malformed response',
        state.netConnectSecureError?.name === 'OrivonError' &&
        state.netConnectSecureError?.code === 'denied' &&
        state.netConnectSecureError?.platformCode === undefined,
        JSON.stringify(state)
      )
      check(
        "the denial is SPECIFICALLY the grant check refusing this origin (net-capability.ts's " +
        'connectSecure(), for want of a grant), matched verbatim so a T3/T13b origin-derivation ' +
        'regression producing the SAME-SHAPED "no authenticated origin" denial does not slide through',
        state.netConnectSecureError?.message === GRANT_DENIAL_MESSAGE,
        JSON.stringify(state)
      )
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)

it('Phase 2: a real https.connect grant, issued through the dev-only path, reaches connectSecure\'s ' +
   'real policy check and real TLS handshake over the real IPC pipe', async () => {
  await runPhase('Phase 2 (connectSecure)', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

      // A manifest CONSTRUCTED for this test, not fetched from the real
      // fixture (apps/fixture/.well-known/orivon.json declares only
      // tcp.connect, and apps/fixture/ belongs to the fixture-app stream --
      // same reasoning as e2e-udp-capability.test.ts's own fixtureManifest).
      // GrantLedger.grant does not check the manifest declaration against
      // what it grants -- the subset check is the permission prompt's job --
      // so this works without the real manifest needing to change.
      const grantPattern = `localhost:${String(TLS_PORT)}`
      const manifest: Manifest = {
        orivonApiVersion: 0,
        id: 'app.orivon.fixture.connect-secure',
        name: 'Orivon Fixture (connectSecure)',
        version: '0.1.0',
        entry: 'index.html',
        capabilities: { net: { https: { connect: [grantPattern] } } }
      }

      const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        return { installed: true as const, grant: await hook(request) }
      }, { origin: FIXTURE_ORIGIN, manifest, capability: 'https.connect', patterns: [grantPattern] } satisfies DevGrantRequest)
      check(
        'the developer-only grant hook is installed in this build (npm run test:e2e builds with ' +
        'ORIVON_ENABLE_DEV_GRANT=1)',
        grantOutcome.installed,
        grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
      )
      if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
      check(
        'the grant returned names exactly https.connect and the one pattern requested',
        grantOutcome.grant.capability === 'https.connect' && JSON.stringify(grantOutcome.grant.patterns) === JSON.stringify([grantPattern]),
        JSON.stringify(grantOutcome.grant)
      )

      // (a) OUTSIDE the granted pattern: '127.0.0.1' is the identical TCP
      // peer as 'localhost' (the server is bound to 127.0.0.1), but
      // connect-secure.ts matches the LITERAL hostname string against the
      // pattern, never a resolved address -- so this is denied by POLICY,
      // before any handshake, proving the grant check runs for a real page's
      // connectSecure call. TLS_PORT is a literal here, not a closed-over
      // variable -- see this file's own doc on TLS_PORT for why.
      const deniedState = await evaluateRetrying(view, async () => {
        const orivon = (window as unknown as {
          orivon: { net: { connectSecure: (o: { host: string, port: number }) => Promise<{ close?: () => Promise<void> } | undefined> } }
        }).orivon
        try {
          const socket = await orivon.net.connectSecure({ host: '127.0.0.1', port: 8877 })
          await socket?.close?.()
          return { rejected: false as const }
        } catch (e) {
          const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
          return { rejected: true as const, code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
        }
      })
      check(
        'a connectSecure to 127.0.0.1, outside the granted "localhost" pattern, is denied over the ' +
        "real IPC pipe with a real 'denied'-coded OrivonError, before any dial is attempted",
        deniedState.rejected && deniedState.name === 'OrivonError' && deniedState.code === 'denied',
        JSON.stringify(deniedState)
      )
      if (deniedState.rejected) {
        check(
          "the policy denial carries no platformCode (errors.ts's uniformity rule)",
          deniedState.platformCode === undefined,
          JSON.stringify(deniedState)
        )
      }

      // (b) INSIDE the granted pattern: reaches the REAL node:tls handshake
      // against the REAL local server. Refused by REAL certificate
      // verification (the production dialTls trusts only the runtime's
      // default store -- see this file's own header for why a successful
      // byte round trip is not achievable hermetically here), which is
      // itself the proof this reached a genuine handshake rather than a
      // stub: a policy-only denial would answer 'denied' with no
      // platformCode, not 'unreachable' with a real one.
      const handshakeState = await evaluateRetrying(view, async () => {
        const orivon = (window as unknown as {
          orivon: { net: { connectSecure: (o: { host: string, port: number }) => Promise<{ close?: () => Promise<void> } | undefined> } }
        }).orivon
        try {
          const socket = await orivon.net.connectSecure({ host: 'localhost', port: 8877 })
          await socket?.close?.()
          return { rejected: false as const }
        } catch (e) {
          const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
          return { rejected: true as const, code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
        }
      })
      check(
        'a connectSecure to the granted host reaches a REAL TLS handshake against a REAL local server ' +
        "and is refused as 'unreachable' by real certificate verification -- not a policy denial, a " +
        'timeout, a crash, or (worst of all) a silent, ungranted success',
        handshakeState.rejected && handshakeState.name === 'OrivonError' && handshakeState.code === 'unreachable',
        JSON.stringify(handshakeState)
      )
      if (handshakeState.rejected) {
        check(
          "the handshake failure carries a real platformCode (mapTlsError's own errnoOf, never undefined " +
          "for a non-OrivonError thrown by node:tls) -- proving `code`/`name`/`platformCode` all survive " +
          "contextBridge intact for THIS lane's own denial path, not just fs.readFileSync's",
          typeof handshakeState.platformCode === 'string' && handshakeState.platformCode.length > 0,
          JSON.stringify(handshakeState)
        )
      }
    } finally {
      await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
