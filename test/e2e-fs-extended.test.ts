// The end-to-end test for orivon.fs's extended surface (queue item 2.1):
// mkdir, readdir, stat, rm, rename. Same two-phase shape as
// ./e2e-sync-fs.test.ts and for the same reason -- see
// ./e2e-capability-boundary.test.ts's own header before changing this
// file's shape.
//
// THE RISK THIS FILE EXISTS TO SETTLE, AND CANNOT SETTLE ON ITS OWN: every
// unit test for these five operations (src/broker/tests/
// index-fs-extended.test.ts, src/broker/adapters/tests/node-adapters.test.ts)
// runs against either a stub filesystem or a real one addressed directly,
// never through the full control-channel pipe. This file is what proves the
// wiring itself -- ipc-validation.ts's param guards, ipc.ts's dispatch
// cases, orivon-surface.ts's closures, main-world-socket.ts's bridge -- all
// reach a REAL directory on REAL disk, under a REAL grant, from REAL page
// code, over the SAME control channel Phase 1 proves correctly denies
// without one.
//
// Phase 1 proves the real pipe without a grant: window.orivon.fs.mkdir
// exists on a real page in the real launched shell, and a real call through
// it is denied because nothing in production calls broker.grant() for any
// origin yet (broker-contracts.ts's own doc on Broker.grant).
//
// Phase 2 is what Phase 1 cannot show: a REAL grant, issued through
// src/main/dev-grant.ts's hook (queue item 0.3's pattern, see
// ./e2e-capability-boundary.test.ts's own Phase 2) against the SAME broker
// the real shell's real IPC pipe is wired to. It builds a real nested
// directory tree on real disk, lists it, stats a real file and a real
// directory, renames a real file, deletes a real subtree recursively, and
// proves BOTH a traversal attempt AND rename's DESTINATION are refused --
// 'denied', with no platformCode -- against the real confinement root, not
// a stub's.
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
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import {
  ADDRESS_BAR_STABLE_TIMEOUT_MS, closeElectronApp, forwardOutput, killChild,
  navigateToFixture, runPhase, waitForTcpReady
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

/** What every one of these calls' outcome reduces to, in page code -- a real OrivonError never survives structured clone back out of page.evaluate() with more than these fields intact. */
interface CallOutcome {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
}

it('Phase 1: the real shell launches, and a real fs.mkdir through the full IPC pipe is correctly denied (no grant exists)', async () => {
  await runPhase('Phase 1', async (check) => {
    try {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

        const state = await evaluateRetrying(view, async (): Promise<{ methods: string[], outcome: CallOutcome }> => {
          const orivon = (window as unknown as {
            orivon: {
              fs: {
                mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
                readdir: (path: string) => Promise<readonly string[]>
                stat: (path: string) => Promise<unknown>
                rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
                rename: (from: string, to: string) => Promise<void>
              }
            }
          }).orivon

          const methods = (['mkdir', 'readdir', 'stat', 'rm', 'rename'] as const)
            .filter((name) => typeof orivon.fs[name] === 'function')

          let outcome: CallOutcome
          try {
            await orivon.fs.mkdir('e2e-denied')
            outcome = { ok: true }
          } catch (e) {
            const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
            outcome = { ok: false, error: { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode } }
          }
          return { methods, outcome }
        })

        check(
          'window.orivon.fs exposes all five extended methods as real functions',
          state.methods.length === 5,
          JSON.stringify(state.methods)
        )
        check(
          "a real fs.mkdir call through the full IPC pipe is correctly denied ('denied', no " +
          'platformCode) -- nothing grants fs in production yet',
          !state.outcome.ok &&
          state.outcome.error?.name === 'OrivonError' &&
          state.outcome.error?.code === 'denied' &&
          state.outcome.error?.platformCode === undefined,
          JSON.stringify(state.outcome)
        )
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

it('Phase 2: a real fs grant lets a real page build, list, stat, rename and delete a real directory ' +
   'tree on real disk, confined per call -- including rename\'s destination', async () => {
  await runPhase('Phase 2', async (check) => {
    try {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

        // The grant, through the production dev-only route (queue item 0.3),
        // exercised inside THIS launched app's own main process -- see
        // ./e2e-sync-fs.test.ts's own Phase 2 for the identical pattern.
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

        // (a) BUILD A REAL NESTED TREE ON REAL DISK, then list, stat, rename
        // and delete it -- one evaluate() so every step runs against the
        // exact same real confinement root, in order.
        const walk = await evaluateRetrying(view, async () => {
          const orivon = (window as unknown as {
            orivon: {
              fs: {
                mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
                readdir: (path: string) => Promise<readonly string[]>
                stat: (path: string) => Promise<{ size: number, isFile: boolean, isDirectory: boolean, mtimeMs: number }>
                rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
                rename: (from: string, to: string) => Promise<void>
                writeFile: (path: string, data: Uint8Array) => Promise<void>
                readFile: (path: string) => Promise<Uint8Array>
              }
            }
          }).orivon

          async function outcomeOf (fn: () => Promise<unknown>): Promise<CallOutcome> {
            try {
              const value = await fn()
              return { ok: true, value }
            } catch (e) {
              const err = e as { code?: unknown, message?: unknown, name?: unknown, platformCode?: unknown }
              return { ok: false, error: { code: err?.code, message: err?.message, name: err?.name, platformCode: err?.platformCode } }
            }
          }

          const bytes = Array.from(new TextEncoder().encode(`e2e fs-extended ${new Date().toISOString()}`))

          const mkdirDeep = await outcomeOf(async () => { await orivon.fs.mkdir('e2e-tree/a/b', { recursive: true }) })
          const listParent = await outcomeOf(async () => await orivon.fs.readdir('e2e-tree/a'))
          await orivon.fs.writeFile('e2e-tree/a/b/leaf.txt', new Uint8Array(bytes))
          const statFile = await outcomeOf(async () => await orivon.fs.stat('e2e-tree/a/b/leaf.txt'))
          const statDir = await outcomeOf(async () => await orivon.fs.stat('e2e-tree/a/b'))

          const renamed = await outcomeOf(async () => { await orivon.fs.rename('e2e-tree/a/b/leaf.txt', 'e2e-tree/a/b/renamed.txt') })
          const readAfterRename = await outcomeOf(async () => Array.from(await orivon.fs.readFile('e2e-tree/a/b/renamed.txt')))
          const readOldNameGone = await outcomeOf(async () => await orivon.fs.readFile('e2e-tree/a/b/leaf.txt'))

          // THE destination-confinement proof, on the real broker: a
          // traversal on `to` alone, `from` completely legitimate.
          const renameEscapeDenied = await outcomeOf(async () => { await orivon.fs.rename('e2e-tree/a/b/renamed.txt', '../../../etc/orivon-e2e-escape') })
          const stillThereAfterEscapeAttempt = await outcomeOf(async () => Array.from(await orivon.fs.readFile('e2e-tree/a/b/renamed.txt')))

          const mkdirTraversalDenied = await outcomeOf(async () => { await orivon.fs.mkdir('../../etc/orivon-e2e-mkdir') })
          const rmTraversalDenied = await outcomeOf(async () => { await orivon.fs.rm('../../etc/passwd') })

          const rmRecursive = await outcomeOf(async () => { await orivon.fs.rm('e2e-tree', { recursive: true }) })
          const readAfterRmGone = await outcomeOf(async () => await orivon.fs.readFile('e2e-tree/a/b/renamed.txt'))

          return {
            bytesWritten: bytes,
            mkdirDeep, listParent, statFile, statDir,
            renamed, readAfterRename, readOldNameGone,
            renameEscapeDenied, stillThereAfterEscapeAttempt,
            mkdirTraversalDenied, rmTraversalDenied,
            rmRecursive, readAfterRmGone
          }
        })

        check('mkdir recursive:true created the whole missing chain on real disk', walk.mkdirDeep.ok, JSON.stringify(walk.mkdirDeep))
        check('readdir lists the real directory entry just created', walk.listParent.ok && Array.isArray(walk.listParent.value) && (walk.listParent.value as string[]).includes('b'), JSON.stringify(walk.listParent))
        check('stat on a real file reports isFile and the real size written', walk.statFile.ok && (walk.statFile.value as { isFile: boolean, size: number })?.isFile === true && (walk.statFile.value as { size: number })?.size === walk.bytesWritten.length, JSON.stringify(walk.statFile))
        check('stat on a real directory reports isDirectory', walk.statDir.ok && (walk.statDir.value as { isDirectory: boolean })?.isDirectory === true, JSON.stringify(walk.statDir))
        check('rename moved the real file on real disk', walk.renamed.ok, JSON.stringify(walk.renamed))
        check('the renamed file reads back with the exact bytes written', walk.readAfterRename.ok && JSON.stringify(walk.readAfterRename.value) === JSON.stringify(walk.bytesWritten), JSON.stringify(walk.readAfterRename))
        check('the old name is really gone after rename (notFound)', !walk.readOldNameGone.ok && walk.readOldNameGone.error?.code === 'notFound', JSON.stringify(walk.readOldNameGone))
        check(
          "rename's DESTINATION is confined on the real broker -- denied, no platformCode, even though the SOURCE is entirely legitimate",
          !walk.renameEscapeDenied.ok && walk.renameEscapeDenied.error?.code === 'denied' && walk.renameEscapeDenied.error?.platformCode === undefined,
          JSON.stringify(walk.renameEscapeDenied)
        )
        check('nothing moved after the refused rename -- the file is still exactly where it was', walk.stillThereAfterEscapeAttempt.ok && JSON.stringify(walk.stillThereAfterEscapeAttempt.value) === JSON.stringify(walk.bytesWritten), JSON.stringify(walk.stillThereAfterEscapeAttempt))
        check('a real mkdir traversal attempt is denied, no platformCode', !walk.mkdirTraversalDenied.ok && walk.mkdirTraversalDenied.error?.code === 'denied' && walk.mkdirTraversalDenied.error?.platformCode === undefined, JSON.stringify(walk.mkdirTraversalDenied))
        check('a real rm traversal attempt is denied, no platformCode -- a refused DELETE, not merely a leak', !walk.rmTraversalDenied.ok && walk.rmTraversalDenied.error?.code === 'denied' && walk.rmTraversalDenied.error?.platformCode === undefined, JSON.stringify(walk.rmTraversalDenied))
        check('rm recursive:true deleted the whole real subtree', walk.rmRecursive.ok, JSON.stringify(walk.rmRecursive))
        check('the deleted subtree is really gone from real disk (notFound)', !walk.readAfterRmGone.ok && walk.readAfterRmGone.error?.code === 'notFound', JSON.stringify(walk.readAfterRmGone))
      } finally {
        await closeElectronApp(app)
      }
    } catch (e) {
      check('Phase 2 (a real fs grant, exercised over the real IPC pipe on real disk) ran without an unexpected failure', false, String((e as Error)?.stack ?? e))
    }
  })
}, TEST_TIMEOUT_MS)
