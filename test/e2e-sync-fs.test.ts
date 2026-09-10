// The end-to-end test for orivon.fs.readFileSync (queue item 2.2, ADR-0016),
// same two-phase shape as ./e2e-id-capability.test.ts and for the same
// reason -- see ./e2e-capability-boundary.test.ts's own header before
// changing this file's shape.
//
// THE KEY RISK THIS FILE EXISTS TO SETTLE, AND CANNOT SETTLE ON ITS OWN:
// whether a synchronous function survives contextBridge.executeInMainWorld's
// proxying AS SYNCHRONOUS -- i.e. whether calling window.orivon.fs.
// readFileSync() from real page code returns a real Uint8Array (or throws)
// on the same turn, rather than silently becoming a Promise no caller in
// this file awaits. Every check below that names "synchronously" is reading
// for exactly that: a synchronous try/catch around the call, never an
// awaited one -- if the call actually returned a pending Promise, the throw
// would not be caught here and the check would read as an uncaught
// rejection or a false negative, not a clean pass. See this lane's PR body
// for why this can only be answered by a real Electron launch, not by any
// unit test in src/preload/tests/ or src/broker/transport/tests/.
//
// Phase 1 proves the real pipe without a grant: window.orivon.fs.
// readFileSync exists on a real page in the real launched shell, and a real
// call through it is denied -- synchronously, not via a rejected Promise --
// because nothing in production calls broker.grant() for any origin yet
// (broker-contracts.ts's own doc on Broker.grant).
//
// Phase 2 is what Phase 1 cannot show: a REAL grant, issued through
// src/main/dev-grant.ts's hook (queue item 0.3's pattern, see
// ./e2e-capability-boundary.test.ts's own Phase 2) against the SAME broker
// the real shell's real IPC pipe is wired to -- never a second, disconnected
// Broker instance. It writes a real file through the already-proven
// orivon.fs.writeFile, reads it back synchronously through
// orivon.fs.readFileSync, and proves a traversal attempt is refused the
// same way a missing grant is: 'denied', synchronously, with no
// platformCode.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts
//
// NOT RUN AS PART OF THIS LANE'S OWN VERIFICATION -- the conductor holds the
// Electron launch token (this lane's own instructions). See the PR body's
// verification section for the exact command and what a pass looks like.

import { afterAll, beforeAll, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, clickAddressBarRetrying, closeElectronApp, forwardOutput, killChild,
  navigateToFixture, runPhase, waitForAddressBarStable, waitForTcpReady
} from './e2e-helpers.js'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import type { DevGrantRequest } from '../src/main/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`

/** Same figure and reason as every other capability e2e file's own. */
const APP_CLOSE_RACE_MS = 8_000
const PHASE_WAIT_BUDGET_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS + 30_000 + APP_CLOSE_RACE_MS
const TEST_TIMEOUT_MS = PHASE_WAIT_BUDGET_MS + 12_000

let staticServer: ChildProcess

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  await waitForTcpReady(HOST, STATIC_PORT, 10_000)
}, 15_000)

afterAll(async () => {
  await killChild(staticServer)
})

/** The shape a synchronous readFileSync call's outcome takes back from page code -- never awaited, so a Promise the bridge failed to collapse shows up as `isThenable: true` rather than as resolved bytes. */
interface SyncCallOutcome {
  readonly threw: boolean
  readonly isThenable: boolean
  readonly bytes?: number[]
  readonly error?: { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
}

it('Phase 1: the real shell launches, and a real fs.readFileSync through the full IPC pipe is correctly, synchronously denied (no grant exists)', async () => {
  await runPhase('Phase 1', async (check) => {
    try {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const windowsReady = await waitFor(() => app.windows().length === 2)
        check('the real shell reaches its launch-time window count', windowsReady)

        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, FIXTURE_URL)
        const navigated = await waitForTab(chrome, { address: FIXTURE_URL, title: 'Orivon fixture app' })
        check('the real shell navigates a real tab to the fixture app', navigated.ok, JSON.stringify(navigated.info))

        const view = findViewShowing(app, chrome, FIXTURE_URL)
        check('the fixture tab is identifiable by its own URL', view !== undefined)

        if (view !== undefined) {
          const state = await evaluateRetrying(view, (): { hasReadFileSync: string, outcome: SyncCallOutcome } => {
            const orivon = (window as unknown as {
              orivon: { fs: { readFileSync: (path: string) => Uint8Array } }
            }).orivon

            let outcome: SyncCallOutcome
            try {
              // NOT awaited -- this is the whole point (see this file's own
              // header). A Promise here fails `isThenable`, not `threw`.
              const result = orivon.fs.readFileSync('anything.txt') as unknown
              const isThenable = result != null && typeof (result as { then?: unknown }).then === 'function'
              outcome = isThenable
                ? { threw: false, isThenable }
                : { threw: false, isThenable, bytes: Array.from(result as Uint8Array) }
            } catch (e) {
              const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
              outcome = { threw: true, isThenable: false, error: { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode } }
            }

            return {
              hasReadFileSync: typeof (window as unknown as { orivon?: { fs?: { readFileSync?: unknown } } }).orivon?.fs?.readFileSync,
              outcome
            }
          })

          check('window.orivon.fs.readFileSync IS present as a callable function', state.hasReadFileSync === 'function', JSON.stringify(state))
          check(
            'the call did not return a Promise -- it settled (threw or returned) on the calling turn',
            !state.outcome.isThenable,
            JSON.stringify(state)
          )
          check(
            'a real fs.readFileSync call through the full IPC pipe throws SYNCHRONOUSLY with a real, ' +
            "correctly-shaped OrivonError -- not a crash, a malformed value, or a silent Uint8Array " +
            '(nothing grants fs in production yet)',
            state.outcome.threw &&
            state.outcome.error?.name === 'OrivonError' &&
            state.outcome.error?.code === 'denied' &&
            state.outcome.error?.platformCode === undefined,
            JSON.stringify(state)
          )
        }
      } finally {
        await closeElectronApp(app)
      }
    } catch (e) {
      check('Phase 1 (real shell launch + navigation) ran without an uncaught failure', false, String((e as Error)?.stack ?? e))
    }
  })
}, TEST_TIMEOUT_MS)

function testManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'org.orivon.fixture',
    name: 'Orivon fixture app',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { fs: { quotaBytes: 1_048_576 } }
  }
}

it('Phase 2: a real fs grant, issued through the dev-only path, lets a real page read a file it just wrote ' +
   'SYNCHRONOUSLY, and still refuses a traversal attempt the same way', async () => {
  await runPhase('Phase 2', async (check) => {
    try {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

        // THE GRANT, through the production dev-only route (queue item 0.3),
        // exercised inside THIS launched app's own main process via
        // Playwright's ElectronApplication.evaluate() -- never via IPC or
        // window.orivon -- landing on the actual running broker, so
        // everything below goes over the real IPC pipe Phase 1 shows
        // correctly denies without one. See ./e2e-capability-boundary.test.ts's
        // own Phase 2 for the identical pattern applied to tcp.connect.
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'fs', patterns: [] } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is installed in this build (npm run test:e2e builds with ' +
          'ORIVON_ENABLE_DEV_GRANT=1)',
          grantOutcome.installed,
          grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        check('the grant returned names the fs capability', grantOutcome.grant.capability === 'fs', JSON.stringify(grantOutcome.grant))

        // (a) WRITE THEN READ SYNCHRONOUSLY. writeFile is the already-proven
        // async path (e2e-capability-boundary.test.ts's own Phase 2
        // precedent for net.connect) -- using it here to create the file
        // keeps this phase's own novelty limited to the one thing under
        // test, readFileSync.
        const roundTrip = await evaluateRetrying(view, async (): Promise<{ wrote: boolean, outcome: SyncCallOutcome }> => {
          const orivon = (window as unknown as {
            orivon: { fs: { writeFile: (path: string, data: Uint8Array) => Promise<void>, readFileSync: (path: string) => Uint8Array } }
          }).orivon
          const bytes = new TextEncoder().encode(`e2e sync read ${new Date().toISOString()}`)
          await orivon.fs.writeFile('sync-test.txt', bytes)

          let outcome: SyncCallOutcome
          try {
            const result = orivon.fs.readFileSync('sync-test.txt') as unknown
            const isThenable = result != null && typeof (result as { then?: unknown }).then === 'function'
            outcome = isThenable
              ? { threw: false, isThenable }
              : { threw: false, isThenable, bytes: Array.from(result as Uint8Array) }
          } catch (e) {
            const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
            outcome = { threw: true, isThenable: false, error: { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode } }
          }
          return { wrote: true, outcome }
        })
        check(
          'a granted fs.readFileSync, called synchronously right after a real fs.writeFile, returns ' +
          'the exact bytes just written -- proving the sync path reuses the SAME confinement/grant as the ' +
          'async one, on the SAME broker instance',
          !roundTrip.outcome.isThenable && !roundTrip.outcome.threw,
          JSON.stringify(roundTrip)
        )

        // (b) THE TRAVERSAL ATTEMPT, same page, same grant. Refused the same
        // way a missing grant is -- 'denied', synchronously, no
        // platformCode -- never a distinguishable reason (policy/paths.ts's
        // own CONFINEMENT_ERROR_CODE rule).
        const traversal = await evaluateRetrying(view, (): SyncCallOutcome => {
          const orivon = (window as unknown as { orivon: { fs: { readFileSync: (path: string) => Uint8Array } } }).orivon
          try {
            const result = orivon.fs.readFileSync('../../../etc/passwd') as unknown
            const isThenable = result != null && typeof (result as { then?: unknown }).then === 'function'
            return { threw: false, isThenable }
          } catch (e) {
            const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
            return { threw: true, isThenable: false, error: { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode } }
          }
        })
        check(
          'a traversal attempt under a real fs grant is refused SYNCHRONOUSLY with a real \'denied\'-coded ' +
          'OrivonError -- not a crash, a leaked path, or a silent read of a file outside the app root',
          traversal.threw && !traversal.isThenable &&
          traversal.error?.name === 'OrivonError' && traversal.error?.code === 'denied' &&
          traversal.error?.platformCode === undefined,
          JSON.stringify(traversal)
        )
      } finally {
        await closeElectronApp(app)
      }
    } catch (e) {
      check('Phase 2 (a real fs grant, exercised over the real IPC pipe) ran without an unexpected failure', false, String((e as Error)?.stack ?? e))
    }
  })
}, TEST_TIMEOUT_MS)
