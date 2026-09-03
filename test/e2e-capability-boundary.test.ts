// The end-to-end capability-enforcement test (docs/development/testing.md
// SS"The end-to-end test"): "the highest-value assertion in the whole plan"
// -- without it, nothing fails if capability enforcement degrades to
// allow-all. Two things, in sequence, against real processes: a granted
// net.connect round-trips real bytes, and the same origin's attempt to
// connect outside its granted pattern is rejected with a real 'denied'
// error, not a timeout, a crash, or a silent success.
//
// WHY THIS IS A VITEST FILE, NOT A PLAIN .mjs SCRIPT LIKE scripts/smoke.mjs.
// Phase 2 below imports real src/broker and src/loader TypeScript directly
// (createBroker, dialTcp/resolveHost, parseManifest) rather than driving the
// app as a black box -- see the header on Phase 2 for why that is
// necessary. Plain `node` cannot resolve a `./index.js` specifier to the
// `index.ts` file that is actually on disk; vitest already does this for
// every other *.test.ts in this repo. Exact precedent for "a *.test.ts
// under a directory vitest.config.ts's `include` does not cover, run
// directly rather than via `npm test`": apps/fixture/manifest.test.ts
// (fixture-01-app, merged). That file's own suggested escape hatch --
// `npx vitest run <path>` -- turned out not to work against this repo's
// installed vitest (4.1.11): an explicit path argument does NOT bypass
// vitest.config.ts's `include` filter in this version, confirmed
// empirically ("No test files found"). test/vitest.e2e.config.ts is the
// other escape hatch that same README names ("a temporary config pointing
// include at..."), scoped to test/**/*.test.ts. Run this file with:
//
//   npx electron-vite build && npx vitest run --config test/vitest.e2e.config.ts
//
// THE GAP THIS TEST WORKS AROUND, READ BEFORE CHANGING THE SHAPE OF THIS
// FILE. docs/development/testing.md's ideal end-to-end test drives the
// fixture app's own frontend (apps/fixture/app.js) through
// `window.orivon.net.connect()`, loaded via a real app loader. Neither
// exists yet, verified by reading the actual code rather than assumed:
//
//   1. src/preload/orivon-surface.ts's exposeOrivon() wires app.manifest,
//      app.grants, fs.readFile and fs.writeFile onto window.orivon -- and
//      nothing else. net.connect is deliberately absent (its own header:
//      the per-socket byte-pump wiring across contextBridge "is not here
//      yet"), even though src/broker/ipc.ts's dispatch() already
//      implements net.connect on the OTHER side of that bridge. So
//      `window.orivon.net` is `undefined` in every real tab today.
//   2. Nothing on `main` ever calls broker.registerApp()/broker.grant() for
//      a real origin -- those are explicitly the app loader's and the
//      permission-prompt UI's seams (src/broker/index.ts's own doc on
//      `Broker.grant`), and neither exists yet. scripts/smoke.mjs's own
//      existing dashboard checks already show this indirectly: an ordinary
//      tab's orivon.app.manifest() returns 'internal' ("no manifest
//      registered"), and orivon.app.grants() is always `[]`.
//
// So a real page in the real launched shell cannot complete a net.connect
// round trip today, whatever grant mechanism a test invents -- there is no
// method on window.orivon to call. Phase 1 below proves exactly that (it is
// real, current, observable behaviour, not a stand-in for the real
// assertion); Phase 2 is "directly exercises... whatever grant mechanism
// exists" (this lane's brief, SSScope) taken as far as it can go: the real
// broker, real Node I/O, real granted-vs-denied enforcement, against a real
// separate echo-server process -- just not carried over real Electron IPC,
// because nothing on the other end of that bridge accepts the call yet.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { launchElectron } from './launch-electron.mjs'
import {
  evaluateRetrying,
  findChrome,
  findViewShowing,
  HERMETIC_RESOLVER,
  waitFor,
  waitForTab
} from './smoke-helpers.mjs'
import { HOST, ECHO_PORT, STATIC_PORT } from '../apps/fixture/config.mjs'
import { createBroker } from '../src/broker/index.js'
import type { BrokerFs, CreateBrokerOptions, Keychain } from '../src/broker/index.js'
import { dialTcp, resolveHost } from '../src/broker/node-adapters.js'
import { isOrivonErrorLike } from '../src/broker/errors.js'
import { parseManifest } from '../src/loader/manifest.js'

// fileURLToPath on a directory URL keeps the trailing separator (the same
// gotcha apps/fixture/serve.mjs's own header documents) -- stripped here so
// join(FIXTURE_DIR, 'echo-server.mjs') below points inside apps/fixture/,
// not apps/.
const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
const MANIFEST_URL = `${FIXTURE_URL}.well-known/orivon.json`

/** Long enough for `electron-vite build`'s output to launch, a real page
 * load, and several loopback TCP round trips -- all of which normally take
 * low single-digit seconds -- with real margin, not a hair trim. */
const TEST_TIMEOUT_MS = 60_000

let echoServer: ChildProcess
let staticServer: ChildProcess

/** Forwards a fixture server child's stdout/stderr, prefixed -- mirrors
 * launch-electron.mjs's own reasoning for the Electron process: Node
 * swallows a child's output by default, and a server that failed to bind
 * (e.g. a leftover process still holding the port from a prior run) must
 * not fail this test silently. */
function forwardOutput (label: string, child: ChildProcess): void {
  child.stdout?.on('data', (d: Buffer) => { process.stderr.write(`[${label}] ${d}`) })
  child.stderr?.on('data', (d: Buffer) => { process.stderr.write(`[${label}] ${d}`) })
}

/** Polls a real TCP connect until it succeeds, per testing.md's own rule
 * (also scripts/smoke.mjs's rule 2): wait for the condition, never a fixed
 * sleep -- a fixture server binding its port is exactly that kind of
 * condition, and a sleep long enough to be safe on a loaded CI box is a
 * needless tax on every fast local run. */
async function waitForTcpReady (host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host, port }, () => { socket.end(); resolve(true) })
      socket.once('error', () => { resolve(false) })
    })
    if (ok) return
    if (Date.now() >= deadline) {
      throw new Error(`nothing accepted a connection on ${host}:${port} within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Kills a child and waits for it to actually exit, escalating to SIGKILL --
 * an orphaned echo-server/serve.mjs process would hold ECHO_PORT/STATIC_PORT
 * for the NEXT run of this file, turning a clean re-run into a confusing
 * "port already in use" failure that has nothing to do with the test. */
async function killChild (child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const onExit = (): void => resolve()
    child.once('exit', onExit)
    child.kill('SIGTERM')
    setTimeout(() => { child.kill('SIGKILL') }, 2_000).unref()
  })
}

/**
 * Waits until `#address`'s own bounding box reads the same twice in a row,
 * or the deadline passes.
 *
 * A plain `.click()` already retries its own "is this element stable" check
 * internally for up to DEFAULT_ACTION_TIMEOUT_MS (launch-electron.mjs) --
 * but that check runs invisibly inside `.click()`, and on a slower CI
 * runner it has been observed to spend the whole ten seconds there: right
 * after `app.windows().length === 2` first holds, the chrome window's
 * WebContentsView can still be mid-layout (src/main/window.ts's resize
 * handler re-runs layoutChrome()/tabs.layout() on a setImmediate deferral,
 * and the omnibox is a flex child of that view's width), which keeps
 * moving `#address` under Playwright's own stability check for reasons
 * that have nothing to do with whether the click itself would work. Naming
 * the same condition explicitly, with this file's own evaluateRetrying/
 * waitFor -- the exact composition smoke-helpers.mjs's waitForTab already
 * uses for a different condition, not a new waiting mechanism -- gives
 * that settling somewhere to happen before the click is attempted, so the
 * click's own ten seconds are spent on the click.
 */
async function waitForAddressBarStable (
  page: ReturnType<typeof findChrome>,
  timeoutMs = 8_000
): Promise<boolean> {
  let previous: string | null = null
  return waitFor(async () => {
    const rect = await evaluateRetrying(page, () => {
      const el = document.querySelector('#address')
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return `${r.x},${r.y},${r.width},${r.height}`
    })
    const stable = rect !== null && rect === previous
    previous = rect
    return stable
  }, timeoutMs)
}

/**
 * Runs one phase's checks into its own `checks`/`failures` lists and its
 * own `expect`, so Phase 1 and Phase 2 below report as fully independent
 * `it()` results -- scripts/smoke.mjs's own rule 1 ("it reports, it does
 * not just exit"), applied per phase rather than once for the whole file.
 */
async function runPhase (
  phaseLabel: string,
  run: (check: (name: string, pass: boolean, detail?: string) => void) => Promise<void>
): Promise<void> {
  const checks: Array<{ name: string, pass: boolean, detail?: string }> = []
  const failures: string[] = []
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, pass } : { name, pass, detail })
    if (!pass) failures.push(detail === undefined ? name : `${name} -- ${detail}`)
  }

  await run(check)

  console.log(JSON.stringify({ phase: phaseLabel, checks }, null, 2))
  if (failures.length > 0) {
    console.error(`\n${phaseLabel} FAILED:`)
    for (const f of failures) console.error(`  - ${f}`)
  } else {
    console.log(`\n${phaseLabel} passed.`)
  }

  expect(failures).toEqual([])
}

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
})

/** Mirrors apps/fixture/app.js's own roundTrip() shape deliberately: this is
 * the exact operation the fixture's frontend performs (write one message,
 * read back exactly as many bytes as were sent -- the echo server has no
 * framing). Phase 2 performs it directly against the broker in place of the
 * page-driven call the gap above rules out. */
async function roundTripBytes (
  socket: { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> },
  message: string
): Promise<string> {
  const sentBytes = new TextEncoder().encode(message)
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
  return new TextDecoder().decode(received)
}

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
// existing: it builds its own Broker instance directly against real Node
// I/O (dialTcp, resolveHost) and never touches the Electron app Phase 1
// launches -- see this file's header for why the two paths are separate at
// all. Both phases do share the echo/static servers started in beforeAll
// above, which is file-level setup independent of either `it()`.

it('Phase 1: the real shell launches and navigates the fixture tab, and the fixture reports its own known net.connect gap honestly', async () => {
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
        // actionability timeout starts competing with it.
        await waitForAddressBarStable(chrome)
        await chrome.click('#address')
        await chrome.fill('#address', FIXTURE_URL)
        await chrome.press('#address', 'Enter')

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
          // transition to read from safely.
          const state = await evaluateRetrying(view, async () => {
            const deadline = Date.now() + 5_000
            while (document.getElementById('status')?.textContent === 'Loading...' && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50))
            }
            return {
              hasOrivon: typeof (window as unknown as { orivon?: unknown }).orivon,
              hasOrivonNet: typeof (window as unknown as { orivon?: { net?: unknown } }).orivon?.net,
              status: document.getElementById('status')?.textContent
            }
          })
          check(
            "the ordinary contextBridge surface IS present (orivon-surface.ts's real wiring)",
            state.hasOrivon === 'object',
            JSON.stringify(state)
          )
          check(
            'window.orivon.net is NOT present -- the gap this test documents, not assumes ' +
            '(src/preload/orivon-surface.ts has no net.connect entry yet)',
            state.hasOrivonNet === 'undefined',
            JSON.stringify(state)
          )
          check(
            "the fixture's own frontend detects the runtime, attempts the call, and reports " +
            "the resulting failure honestly (apps/fixture/app.js's real catch branch)",
            state.status === 'Connect failed.',
            JSON.stringify(state)
          )
        }
      } finally {
        // FOUND THIS LANE, by direct instrumented reproduction (not the
        // documented C6 attach issue -- a different symptom of the same
        // driver class): `_electron`'s `app.close()` hangs INDEFINITELY here
        // while any tab remains open, confirmed down to a launch with zero
        // navigation. scripts/smoke.mjs's own "MUST RUN LAST" comment on its
        // close-everything check was already the fix for this, just not
        // stated as one -- closing every tab first (which fires
        // src/main/index.ts's window-all-closed -> app.quit()) makes
        // app.close() resolve in ~100ms instead. Reproduced with:
        // app.windows().length === 2, no navigation, app.close() -- still
        // hung past 20s. THE FIX, applied here: close every tab via the same
        // real click smoke.mjs uses, wait for the transition to zero
        // windows, then close(). A bounded race + process kill is kept as a
        // last-resort net in case a future regression (a selector rename,
        // say) silently breaks the tab-closing step -- so a REGRESSION here
        // degrades to a slow, reported failure, never a second silent hang.
        const chromeForTeardown = app.windows().find((w) => w.url().endsWith('/renderer/index.html'))
        if (chromeForTeardown !== undefined) {
          const ids: string[] = await evaluateRetrying(chromeForTeardown, () =>
            Array.from(document.querySelectorAll('.tab')).map((el) => (el as HTMLElement).dataset.id ?? '')
          ).catch(() => [])
          for (const id of ids) {
            await chromeForTeardown.click(`[data-id="${id}"] .close`).catch(() => {})
          }
        }
        await waitFor(() => app.windows().length === 0)
        const closed = await Promise.race([
          app.close().then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000))
        ])
        if (!closed) app.process().kill()
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

it('Phase 2: the real broker grants a round trip and denies an out-of-manifest connection', async () => {
  await runPhase('Phase 2', async (check) => {
    // ---- the real broker, real I/O, granted vs. denied
    // Constructs its OWN Broker instance with REAL dependencies (dialTcp,
    // resolveHost -- src/broker/node-adapters.ts, no `electron` import, real
    // node:net/node:dns) rather than the stubs every unit test in
    // src/broker/*.test.ts uses. registerApp()/grant() are called exactly as
    // the (not-yet-built) app loader and permission-prompt UI will call them
    // -- see this file's header for why nothing today can do that over real
    // IPC instead. No dependency on Phase 1's Electron app -- see the note
    // above both `it()` blocks.
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

      const fsStub: BrokerFs = {
        rootFor: () => { throw new Error('fs is not exercised by this test') },
        realpathSync: () => { throw new Error('fs is not exercised by this test') },
        readFile: async () => { throw new Error('fs is not exercised by this test') },
        writeFile: async () => { throw new Error('fs is not exercised by this test') }
      }
      const keychainStub: Keychain = {
        getSeed: async () => { throw new Error('identity is not exercised by this test') }
      }
      const deps: CreateBrokerOptions = {
        dial: dialTcp,
        resolve: resolveHost,
        now: () => Date.now(),
        fs: fsStub,
        keychain: keychainStub
      }
      const broker = createBroker(deps)
      await broker.registerApp(FIXTURE_ORIGIN, parsed.manifest)
      await broker.grant(FIXTURE_ORIGIN, 'tcp.connect', patterns)

      // (a) THE GRANTED PATH. Real dial, over real loopback TCP, to the real
      // echo-server child process started in beforeAll -- a real bytes-out,
      // bytes-back round trip, not a stub standing in for one.
      try {
        const socket = await broker.net.connect(FIXTURE_ORIGIN, { host: HOST, port: ECHO_PORT })
        const message = `e2e round trip ${new Date().toISOString()}`
        const received = await roundTripBytes(socket, message)
        await socket.close()
        check(
          'the granted connection dials the real echo server and round-trips the exact bytes sent',
          received === message,
          `sent ${JSON.stringify(message)}, received ${JSON.stringify(received)}`
        )
      } catch (e) {
        check('the granted connection succeeds', false, String((e as Error)?.stack ?? e))
      }

      // (b) THE OUT-OF-MANIFEST PATH. ECHO_PORT + 1: still 127.0.0.1 (an
      // address literal, so checkConnect never calls resolveFn -- no real DNS
      // anywhere in this test, keeping it hermetic on loopback alone), and
      // nothing listens there, but that is not what denies it: the granted
      // pattern is `HOST:ECHO_PORT` with an exact port, so
      // connect-patterns.ts's portMatches/couldAnyPatternMatch denies this
      // BEFORE any dial is attempted -- verified by reading that file, not
      // assumed. A denial that happened to also be unreachable would prove
      // nothing about policy; this one is denied on the pattern alone.
      const deniedPort = ECHO_PORT + 1
      try {
        await broker.net.connect(FIXTURE_ORIGIN, { host: HOST, port: deniedPort })
        check(
          `a connection to ${HOST}:${String(deniedPort)}, outside the granted pattern, is rejected`,
          false,
          'the call resolved instead of rejecting -- capability enforcement did not fire'
        )
      } catch (e) {
        const denied = isOrivonErrorLike(e) && e.code === 'denied'
        check(
          `a connection to ${HOST}:${String(deniedPort)}, outside the granted pattern, is denied ` +
          "with a real 'denied'-coded OrivonError -- not a timeout, a crash, or silent success",
          denied,
          denied ? undefined : String((e as Error)?.stack ?? e)
        )
        if (denied && isOrivonErrorLike(e)) {
          check(
            "the denial carries no platformCode -- contracts/errors.ts's uniformity rule " +
            '(a denial that varied by reason would turn the boundary into a probe target)',
            e.platformCode === undefined,
            JSON.stringify(e)
          )
        }
      }
    } catch (e) {
      check('Phase 2 (real broker exercise) ran without an unexpected failure', false, String((e as Error)?.stack ?? e))
    }
  })
}, TEST_TIMEOUT_MS)
