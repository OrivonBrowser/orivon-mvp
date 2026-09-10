// The end-to-end capability-enforcement test (docs/development/testing.md
// SS"The end-to-end test"): "the highest-value assertion in the whole plan"
// -- without it, nothing fails if capability enforcement degrades to
// allow-all. Two things, in sequence, against real processes: a granted
// net.connect round-trips real bytes, and the same origin's attempt to
// connect outside its granted pattern is rejected with a real 'denied'
// error, not a timeout, a crash, or a silent success.
//
// WHY THIS IS A VITEST FILE, NOT A PLAIN .mjs SCRIPT LIKE scripts/smoke.mjs.
// Phase 2 below imports real src/loader TypeScript directly (parseManifest)
// rather than driving the app as a black box -- see the header on Phase 2
// for why that is necessary. Plain `node` cannot resolve a `./index.js`
// specifier to the `index.ts` file that is actually on disk; vitest already does this for
// every other *.test.ts in this repo. Exact precedent for "a *.test.ts
// under a directory vitest.config.ts's `include` does not cover, run
// directly rather than via `npm test`": apps/fixture/manifest.test.ts
// (fixture-01-app, merged). That file's own suggested escape hatch --
// `npx vitest run <path>` -- turned out not to work against this repo's
// installed vitest (4.1.11): an explicit path argument does NOT bypass
// vitest.config.ts's `include` filter in this version, confirmed
// empirically ("No test files found"). test/vitest.e2e.config.ts is the
// other escape hatch that same README names ("a temporary config pointing
// include at..."), scoped to test/**/*.test.ts. Run this file with
// `npm run test:e2e`, or directly:
//
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts
//
// NOT a bare `electron-vite build` -- that omits ORIVON_ENABLE_DEV_GRANT=1,
// so Phase 2's dev-grant hook (below) would be absent and it would fail
// immediately, by design (docs/planning/unattended-build-queue.md item 0.3).
//
// THE GAP THIS TEST WORKS AROUND, READ BEFORE CHANGING THE SHAPE OF THIS
// FILE. docs/development/testing.md's ideal end-to-end test drives the
// fixture app's own frontend (apps/fixture/app.js) through
// `window.orivon.net.connect()`, loaded via a real app loader, and completes
// a real granted round trip. The app loader half still does not exist,
// verified by reading the actual code rather than assumed:
//
//   Nothing on `main` ever calls broker.registerApp()/broker.grant() for a
//   real origin -- those are explicitly the app loader's and the
//   permission-prompt UI's seams (src/broker/index.ts's own doc on
//   `Broker.grant`), and neither exists yet. scripts/smoke.mjs's own
//   existing dashboard checks already show this indirectly: an ordinary
//   tab's orivon.app.manifest() returns 'internal' ("no manifest
//   registered"), and orivon.app.grants() is always `[]`.
//
// WHAT CHANGED (stream/broker-24-preload-net-surface): `window.orivon.net`
// is no longer absent. src/preload/orivon-surface.ts now wires net.connect
// onto window.orivon for real, via contextBridge.executeInMainWorld -- so a
// real page in the real launched shell CAN now reach the full IPC/broker
// pipe. What it still cannot do is complete a GRANTED round trip, because
// nothing grants it anything. Phase 1 below now proves the pipe itself:
// window.orivon.net.connect exists, a real call through it reaches the real
// broker's real policy check over real Electron IPC, and correctly comes
// back denied -- not a timeout, not a crash, not a malformed error, not a
// silent success. That is real, current, observable behaviour, not a
// stand-in for the ideal test. A REAL, PRODUCTION grant -- an app loader and
// a permission-prompt UI a person actually approved -- is still build step
// 4's job, not this file's.
//
// UPDATED (docs/planning/unattended-build-queue.md item 0.3): Phase 2 used
// to build its own, separate Broker instance and call its registerApp()/
// grant() directly from test code, disconnected from the real launched
// shell -- so it proved the broker's OWN logic under a grant, but never
// that a grant issued anywhere reaches the real IPC pipe Phase 1 exercises.
// It now grants through src/main/dev-grant.ts's developer-only hook instead
// -- reachable only via Playwright's ElectronApplication.evaluate(), never
// via window.orivon or any renderer-facing surface, and absent entirely
// from an ordinary build (scripts/check-dev-grant-absent.mjs) -- against
// the SAME broker instance the real shell's real IPC is wired to. What
// Phase 2 now proves: a real page's window.orivon.net.connect, over the
// real IPC pipe Phase 1 shows correctly denies without one, completes a
// real granted round trip once that same pipe's broker holds a grant, and
// still denies a connection outside it.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS, launchElectron } from './launch-electron.mjs'
import {
  evaluateRetrying,
  findChrome,
  findViewShowing,
  HERMETIC_RESOLVER,
  WAIT_TIMEOUT_MS,
  waitFor,
  waitForTab
} from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, forwardOutput,
  killChild, navigateToFixture, runPhase, waitForAddressBarStable, waitForTcpReady
} from './e2e-helpers.js'
import { HOST, ECHO_PORT, STATIC_PORT } from '../apps/fixture/config.mjs'
import { parseManifest } from '../src/loader/manifest.js'
import type { DevGrantRequest } from '../src/main/dev-grant.js'
import type { Grant } from '../src/contracts/index.js'

// fileURLToPath on a directory URL keeps the trailing separator (the same
// gotcha apps/fixture/serve.mjs's own header documents) -- stripped here so
// join(FIXTURE_DIR, 'echo-server.mjs') below points inside apps/fixture/,
// not apps/.
const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
const MANIFEST_URL = `${FIXTURE_URL}.well-known/orivon.json`

/**
 * Phase 1's own worst-case wait budget, walked in the order its body
 * actually awaits them -- each figure is the REAL ceiling that call site
 * enforces, not a guess:
 *
 *   waitFor(windowsReady)              WAIT_TIMEOUT_MS               8_000
 *   waitForAddressBarStable            ADDRESS_BAR_STABLE_TIMEOUT_MS 8_000
 *   clickAddressBarRetrying, worst case (the first click hits C6's known
 *   flake and the single retry fires): first click, re-settle, retried
 *   click, fill, press -- five actions, two of them DEFAULT_ACTION_TIMEOUT_MS
 *   apart from the one extra waitForAddressBarStable in between:
 *     click (1st attempt)               DEFAULT_ACTION_TIMEOUT_MS     10_000
 *     waitForAddressBarStable (retry)   ADDRESS_BAR_STABLE_TIMEOUT_MS  8_000
 *     click (2nd attempt) + fill + press DEFAULT_ACTION_TIMEOUT_MS x3 30_000
 *   waitForTab                          WAIT_TIMEOUT_MS               8_000
 *   evaluateRetrying (Loading clears)   WAIT_TIMEOUT_MS               8_000
 *   evaluateRetrying (grants + connect) WAIT_TIMEOUT_MS               8_000
 *   teardown: waitFor(windows === 0)    WAIT_TIMEOUT_MS               8_000
 *   teardown: app.close() race          APP_CLOSE_RACE_MS             8_000
 *                                                            total: 104_000
 *
 * E-F2 (docs/open-questions.md A76): the page-state read used to be ONE
 * evaluateRetrying call doing both the "wait for Loading to clear" poll and
 * the full net.connect IPC round trip, sharing a single WAIT_TIMEOUT_MS --
 * on a loaded CI runner the poll alone could spend most of that budget,
 * leaving too little for the round trip this file exists to prove, and a
 * timeout there reported evaluateRetrying's own generic message instead of
 * the real failure. Split into two calls below, each billed its own full
 * WAIT_TIMEOUT_MS here.
 *
 * Kept as an actual sum of the real constants, not restated as a bare
 * number, so the next person who adds a wait to this critical path sees
 * whether TEST_TIMEOUT_MS below still covers it -- from this arithmetic,
 * not from a flaky CI run months later.
 */
const PHASE1_WAIT_BUDGET_MS =
  WAIT_TIMEOUT_MS +
  ADDRESS_BAR_STABLE_TIMEOUT_MS +
  DEFAULT_ACTION_TIMEOUT_MS + ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 +
  WAIT_TIMEOUT_MS +
  WAIT_TIMEOUT_MS +
  WAIT_TIMEOUT_MS +
  WAIT_TIMEOUT_MS +
  APP_CLOSE_RACE_MS

/** Long enough for `electron-vite build`'s output to launch, a real page
 * load, several loopback TCP round trips, and Phase 1's own worst-case wait
 * budget above -- real margin, not a hair trim, and not a round number
 * picked by feel either: PHASE1_WAIT_BUDGET_MS plus headroom for
 * process-spawn jitter on a loaded CI box. */
const TEST_TIMEOUT_MS = PHASE1_WAIT_BUDGET_MS + 12_000

let echoServer: ChildProcess
let staticServer: ChildProcess


beforeAll(async () => {
  echoServer = spawn(process.execPath, [join(FIXTURE_DIR, 'echo-server.mjs')], { stdio: 'pipe' })
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('echo-server', echoServer)
  forwardOutput('fixture-server', staticServer)
  await Promise.all([
    waitForTcpReady(HOST, ECHO_PORT, 10_000),
    waitForTcpReady(HOST, STATIC_PORT, 10_000)
  ])
}, 15_000)

afterAll(async () => {
  await Promise.all([killChild(echoServer), killChild(staticServer)])
  // The suite's own self-check (unattended-run-protocol.md): after every
  // `it` above has torn its own app down, nothing this file launched may
  // still be a live Electron process.
  expect(await assertNoElectronSurvivors()).toEqual([])
})

// Phase 1 and Phase 2 are independent `it()` blocks, not two halves of one
// test. A single combined test meant a flaky UI click in Phase 1 could red
// the whole file's one aggregate assertion and bury a Phase 2 that had
// already reported pass:true for every capability-enforcement check --
// exactly the failure shape this project has decided to stop tolerating:
// an alarm that fires for the wrong reason trains people to ignore it, and
// the day it fires because the capability boundary genuinely broke, that
// gets waved through as "that flaky one again." Splitting them means a
// Phase 1 result and a Phase 2 result are always visible independently.
//
// Phase 2 has no dependency on Phase 1 having run, or succeeded, or even
// existing: it launches its OWN separate Electron app rather than reusing
// Phase 1's -- see this file's header for why the two paths are kept
// independent `it()` results. Both phases do share the echo/static servers
// started in beforeAll above, which is file-level setup independent of
// either `it()`.

/**
 * The EXACT text `src/broker/index.ts`'s `connect()` throws when
 * `ledger.currentGrant(key, 'tcp.connect')` finds no grant for this origin --
 * the one call site that can produce it. Matched verbatim below (E-F1,
 * `docs/open-questions.md` A76) rather than a loose pattern like /denied/i:
 * `src/broker/transport/ipc.ts`'s EARLIER, unrelated check -- "no authenticated origin
 * for this frame", thrown before `dispatch()` ever reaches the grant check --
 * produces the identical `{ name: 'OrivonError', code: 'denied',
 * platformCode: undefined }` shape. A T3/T13b origin-derivation regression
 * that made that earlier check fire instead would satisfy the old, looser
 * assertion just as well as a real grant denial -- exactly the kind of bug
 * this file exists to catch.
 */
const GRANT_DENIAL_MESSAGE = 'tcp.connect is not granted to this origin'

it('Phase 1: the real shell launches, and a real net.connect through the full IPC pipe is correctly denied (no grant exists)', async () => {
  await runPhase('Phase 1', async (check) => {
    // ---- the real shell, the real page, the real (documented) gap
    // Launches via test/launch-electron.mjs -- the only correct way to start
    // Electron in this repo (ELECTRON_RUN_AS_NODE=1 is ambient here) -- and
    // exercises the exact Playwright `_electron` attach path the known,
    // previously-unresolved risk (docs/open-questions.md C6) is about,
    // early, per docs/development/testing.md's own instruction.
    try {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        // scripts/smoke.mjs's own rule (and its header's own incident report):
        // app.windows() is empty for a brief window right after launch --
        // findChrome() throws immediately on an empty list, and this app's
        // OWN close() sequence, called on a still-initialising app in that
        // finally block, was observed (this lane's own debugging, not the
        // documented C6 issue) to hang rather than reject, turning a fast
        // fixable race into a full test-timeout hang. Wait for the real
        // launch-time window count first, exactly as smoke.mjs does.
        const windowsReady = await waitFor(() => app.windows().length === 2)
        check(
          'the real shell reaches its launch-time window count (chrome + one default tab)',
          windowsReady,
          windowsReady ? undefined : `saw ${app.windows().length} window(s)`
        )

        const chrome = findChrome(app)
        // See waitForAddressBarStable's own header (above beforeAll/afterAll):
        // a real, observed CI-runner layout race, not a capability concern --
        // this gives it somewhere to finish before the click's own
        // actionability timeout starts competing with it. Its result is
        // named and reported here rather than discarded: a genuine failure
        // to stabilise must read as THIS check failing, not as a confusing
        // downstream `.click()` action timeout with no diagnostic pointing
        // at the address bar at all.
        const addressBarStable = await waitForAddressBarStable(chrome)
        check(
          "the address bar's own layout settles before the click " +
          '(waitForAddressBarStable -- see its header for the CI-runner ' +
          'layout race this guards against)',
          addressBarStable,
          addressBarStable ? undefined : `did not read stable within ${ADDRESS_BAR_STABLE_TIMEOUT_MS}ms`
        )
        await clickAddressBarRetrying(chrome, FIXTURE_URL)

        const navigated = await waitForTab(chrome, { address: FIXTURE_URL, title: 'Orivon fixture app' })
        check(
          'the real shell navigates a real tab to the fixture app over real localhost HTTP',
          navigated.ok,
          navigated.ok ? undefined : `saw ${JSON.stringify(navigated.info)}`
        )

        const view = findViewShowing(app, chrome, FIXTURE_URL)
        check('the fixture tab is identifiable by its own URL', view !== undefined)

        if (view !== undefined) {
          // Read AFTER the page's own main() has had a chance to run to
          // completion -- it is a synchronous chain of awaits with no
          // network of its own (fetch of a local manifest, then either the
          // "no runtime" branch or a doomed net.connect call), so waiting
          // for the status text to stop reading "Loading..." is enough of a
          // transition to read from safely. E-F2: its own bounded call,
          // separate from the round trip below -- see PHASE1_WAIT_BUDGET_MS's
          // own note on why sharing one evaluateRetrying budget was a flake
          // risk.
          await evaluateRetrying(view, async () => {
            const deadline = Date.now() + 5_000
            while (document.getElementById('status')?.textContent === 'Loading...' && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50))
            }
          })

          // A SECOND, INDEPENDENT connect attempt, made directly here rather
          // than relying only on the fixture's own display text (which
          // stringifies a plain OrivonError-shaped rejection as "[object
          // Object]" -- apps/fixture/app.js's `error instanceof Error` check
          // is false for it by design, see orivon-surface.ts's own header).
          // This is what actually proves the full pipe: window.orivon.net.
          // connect -> the real preload/main-world wiring -> real Electron
          // IPC -> the real broker's real policy check -> a real denial,
          // propagated all the way back as a rejected promise IN THE PAGE.
          // The literal host:port here need not have anything listening --
          // checkConnect denies for want of a grant before any dial is ever
          // attempted.
          const state = await evaluateRetrying(view, async () => {
            const orivon = (window as unknown as {
              orivon: {
                app: { grants: () => Promise<unknown> }
                net: { connect: (o: unknown) => Promise<{ close?: () => Promise<void> } | undefined> }
              }
            }).orivon

            // E-F1's extra rigor: prove the frame IS authenticated -- origin
            // derivation (ipc.ts's originFromSenderFrame, T3/T13b) already
            // succeeded and dispatch() actually ran -- independently of the
            // net.connect grant check below. app.grants() resolves to `[]`
            // for an authenticated origin the ledger has never registered
            // (grant-ledger.ts's grantsFor), rather than rejecting: nothing
            // about it depends on any grant existing, only on the origin
            // being real.
            let grantsResult: unknown
            let grantsRejected = false
            try {
              grantsResult = await orivon.app.grants()
            } catch {
              grantsRejected = true
            }

            // E-F3: capture the call's return value WITHOUT awaiting it
            // first, so a synchronous throw -- a different and worse
            // regression than a rejected promise, since it would break every
            // `.catch()`-based caller -- is distinguishable from the
            // rejection this check actually claims to prove.
            let netConnectIsThenable = false
            let netConnectError
            try {
              const pending = orivon.net.connect({ host: '127.0.0.1', port: 8873 })
              netConnectIsThenable = typeof (pending as unknown as { then?: unknown })?.then === 'function'
              const socket = await pending
              // Unexpected success IS this check correctly failing -- the
              // real security regression this file exists to catch -- but
              // the real broker-side handle and its MessagePort must not
              // leak in the Electron process for the rest of the run (E-F6).
              await socket?.close?.()
            } catch (e) {
              const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
              netConnectError = { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
            }

            return {
              hasOrivon: typeof (window as unknown as { orivon?: unknown }).orivon,
              hasOrivonNet: typeof (window as unknown as { orivon?: { net?: unknown } }).orivon?.net,
              hasOrivonNetConnect: typeof (window as unknown as { orivon?: { net?: { connect?: unknown } } }).orivon?.net?.connect,
              grantsOk: !grantsRejected && Array.isArray(grantsResult),
              netConnectIsThenable,
              netConnectError
            }
          })
          check(
            "the ordinary contextBridge surface IS present (orivon-surface.ts's real wiring)",
            state.hasOrivon === 'object',
            JSON.stringify(state)
          )
          check(
            'window.orivon.net IS present -- stream/broker-24-preload-net-surface wired it ' +
            'onto window.orivon via contextBridge.executeInMainWorld',
            state.hasOrivonNet === 'object',
            JSON.stringify(state)
          )
          check(
            'window.orivon.net.connect IS a callable function, not merely a truthy placeholder ' +
            '(E-F4) -- an `orivon.net = {}` regression would otherwise surface one check later as ' +
            'a confusing generic TypeError rather than pointing at the actual gap',
            state.hasOrivonNetConnect === 'function',
            JSON.stringify(state)
          )
          check(
            'the frame is authenticated BEFORE the connect attempt -- orivon.app.grants() resolves ' +
            "(to `[]`, for an origin the ledger has never registered) rather than rejecting, " +
            "proving origin derivation already succeeded independently of the grant check below " +
            '(E-F1)',
            state.grantsOk,
            JSON.stringify(state)
          )
          check(
            'orivon.net.connect() returns a real thenable synchronously, before any rejection -- ' +
            'not a synchronous throw, which would be a different and worse regression breaking ' +
            'every `.catch()`-based caller (E-F3)',
            state.netConnectIsThenable,
            JSON.stringify(state)
          )
          check(
            'a real net.connect through the full IPC pipe is denied with a real, correctly ' +
            '-shaped OrivonError -- not a timeout, a crash, or a malformed response',
            state.netConnectError?.name === 'OrivonError' &&
            state.netConnectError?.code === 'denied' &&
            state.netConnectError?.platformCode === undefined,
            JSON.stringify(state)
          )
          check(
            "the denial is SPECIFICALLY the grant check refusing this origin (src/broker/index.ts's " +
            "connect(), for want of a grant), not ipc.ts's EARLIER, unrelated \"no authenticated " +
            'origin for this frame\" check answering first -- which would be a real T3/T13b ' +
            'origin-derivation regression this test must not let slide through unnoticed (E-F1)',
            state.netConnectError?.message === GRANT_DENIAL_MESSAGE,
            JSON.stringify(state)
          )
        }
      } finally {
        // Same shared teardown as Phase 2 below -- see closeElectronApp's
        // own header (test/e2e-helpers.ts) for the close-hang workaround
        // this performs, and closeElectron's for why it now runs
        // unconditionally rather than only when this `finally` itself runs
        // to completion.
        await closeElectronApp(app)
      }
    } catch (e) {
      check(
        'Phase 1 (real shell launch + navigation) ran without the known _electron attach ' +
        'issue reproducing (docs/open-questions.md C6) or any other uncaught failure',
        false,
        String((e as Error)?.stack ?? e)
      )
    }
  })
}, TEST_TIMEOUT_MS)

it('Phase 2: a real grant, issued through the dev-only path rather than test code calling ' +
   'broker.grant() itself, lets a real page round-trip bytes and still denies an out-of-manifest connection', async () => {
  await runPhase('Phase 2', async (check) => {
    // ---- a real grant, on the SAME broker the real IPC pipe is wired to
    // Fetches and parses the fixture's real manifest exactly as its own page
    // does, then grants it via src/main/dev-grant.ts's hook -- invoked
    // through Playwright's ElectronApplication.evaluate(), which runs
    // inside THIS launched app's own main process, never via IPC or
    // window.orivon. This is queue item 0.3's replacement for this test
    // calling broker.registerApp()/grant() itself: the grant lands on the
    // actual running broker, so everything after it goes over the real IPC
    // pipe Phase 1 shows correctly denies without one, not a second,
    // disconnected Broker instance. Independent of Phase 1's own app -- see
    // the note above both `it()` blocks.
    try {
      const manifestResponse = await fetch(MANIFEST_URL)
      const manifestText = await manifestResponse.text()
      const parsed = parseManifest(manifestText)
      check('the fixture manifest, fetched over real HTTP, is accepted by the real parseManifest', parsed.ok)
      if (!parsed.ok) throw new Error(`manifest rejected: ${parsed.reason}`)

      const patterns = parsed.manifest.capabilities.net?.tcp?.connect ?? []
      check(
        'the fetched manifest declares exactly the granted echo-server pattern, nothing wider',
        patterns.length === 1 && patterns[0] === `${HOST}:${ECHO_PORT}`,
        JSON.stringify(patterns)
      )

      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: FIXTURE_ORIGIN, manifest: parsed.manifest, capability: 'tcp.connect', patterns } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is installed in this build (npm run test:e2e builds with ' +
          'ORIVON_ENABLE_DEV_GRANT=1 -- scripts/build-e2e.mjs, electron.vite.config.ts, src/main/dev-grant.ts)',
          grantOutcome.installed,
          grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        check(
          'the grant returned names exactly the capability and patterns requested',
          grantOutcome.grant.capability === 'tcp.connect' && JSON.stringify(grantOutcome.grant.patterns) === JSON.stringify(patterns),
          JSON.stringify(grantOutcome.grant)
        )

        // (a) THE GRANTED PATH, driven from the real page over the real IPC
        // pipe: write, then read back exactly as many bytes as were sent
        // (the echo server carries no framing) -- apps/fixture/app.js's own
        // roundTrip() shape, exercised here through window.orivon.net.connect
        // directly. Port 8873 matches ECHO_PORT (apps/fixture/config.mjs) --
        // hardcoded rather than closed over, the same reason Phase 1 above
        // hardcodes its own literal port: a value crossing evaluate()'s
        // serialization boundary as a closure, rather than as an explicit
        // argument, does not survive it.
        const roundTrip = await evaluateRetrying(view, async () => {
          const orivon = (window as unknown as {
            orivon: { net: { connect: (o: { host: string, port: number }) => Promise<{
              readable: ReadableStream<Uint8Array>
              writable: WritableStream<Uint8Array>
              close: () => Promise<void>
            }> } }
          }).orivon
          const message = `e2e round trip ${new Date().toISOString()}`
          const sentBytes = new TextEncoder().encode(message)
          const socket = await orivon.net.connect({ host: '127.0.0.1', port: 8873 })
          try {
            const writer = socket.writable.getWriter()
            await writer.write(sentBytes)
            await writer.close()

            const reader = socket.readable.getReader()
            let received = new Uint8Array(0)
            while (received.length < sentBytes.length) {
              const { value, done } = await reader.read()
              if (done) break
              const merged = new Uint8Array(received.length + value.length)
              merged.set(received)
              merged.set(value, received.length)
              received = merged
            }
            return { sent: message, received: new TextDecoder().decode(received) }
          } finally {
            await socket.close()
          }
        })
        check(
          'the granted connection, made from the real page over the real IPC pipe, dials the real ' +
          'echo server and round-trips the exact bytes sent',
          roundTrip.received === roundTrip.sent,
          `sent ${JSON.stringify(roundTrip.sent)}, received ${JSON.stringify(roundTrip.received)}`
        )

        // (b) THE OUT-OF-MANIFEST PATH, same page, same pipe. 8874 is
        // ECHO_PORT + 1 (hardcoded for the reason above): still 127.0.0.1
        // (an address literal, so checkConnect never calls resolveFn -- no
        // real DNS anywhere in this test), and nothing listens there, but
        // that is not what denies it -- the granted pattern names ECHO_PORT
        // exactly, so connect-patterns.ts's portMatches/couldAnyPatternMatch
        // denies this BEFORE any dial is attempted. A denial that happened
        // to also be unreachable would prove nothing about policy; this one
        // is denied on the pattern alone.
        const deniedState = await evaluateRetrying(view, async () => {
          const orivon = (window as unknown as {
            orivon: { net: { connect: (o: { host: string, port: number }) => Promise<{ close?: () => Promise<void> } | undefined> } }
          }).orivon
          try {
            const socket = await orivon.net.connect({ host: '127.0.0.1', port: 8874 })
            await socket?.close?.()
            return { rejected: false as const }
          } catch (e) {
            const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
            return { rejected: true as const, code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode }
          }
        })
        check(
          'a connection to 127.0.0.1:8874, outside the granted pattern, is denied over the real IPC ' +
          "pipe with a real 'denied'-coded OrivonError -- not a timeout, a crash, or silent success",
          deniedState.rejected && deniedState.name === 'OrivonError' && deniedState.code === 'denied',
          JSON.stringify(deniedState)
        )
        if (deniedState.rejected) {
          check(
            "the denial carries no platformCode -- contracts/errors.ts's uniformity rule " +
            '(a denial that varied by reason would turn the boundary into a probe target)',
            deniedState.platformCode === undefined,
            JSON.stringify(deniedState)
          )
        }
      } finally {
        await closeElectronApp(app)
      }
    } catch (e) {
      check(
        'Phase 2 (a real grant through the dev-only path, exercised over the real IPC pipe) ' +
        'ran without an unexpected failure',
        false,
        String((e as Error)?.stack ?? e)
      )
    }
  })
}, TEST_TIMEOUT_MS)
