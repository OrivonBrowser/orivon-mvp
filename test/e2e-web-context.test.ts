// orivon.web.openContext end to end (ADR-0019), against the real shell and
// the real broker -- the spec's own item 7. Same launch/grant-hook/teardown
// shape as ./e2e-third-party-reach.test.ts and ./e2e-id-capability.test.ts:
// the developer-only grant hook (src/main/dev-grant.js), never window.orivon,
// grants against the SAME broker instance the real launched app's real IPC
// is wired to.
//
// HERMETIC BY CONSTRUCTION: the opener holds `web.context` for
// `https://example.com` but NO `https.connect` grant at all, so every
// `fetch()` a context makes is refused by `authoriseReachFor` before any
// dial is attempted -- real network access is never reached from this file.
// The ONE case that needs the real internet (a granted context's own
// `fetch()` actually succeeding) is deliberately kept out of this file and
// lives in ./e2e-web-context-network.test.ts instead, with its own header
// explaining why.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-web-context.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './support/smoke-helpers.mjs'
import { asPage, closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from './support/e2e-helpers.js'
import { AS_PAGE_SCRIPT_URL, clearFixtureAsPageScript, setFixtureAsPageScript } from './fixture-as-page.js'
import { HOST, STATIC_PORT } from './apps/fixture/config.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
/** asPage's (e2e-helpers.ts) same-origin script URL: every window.orivon call below runs as a script the fixture page loaded, never through page.evaluate() (ADR-0045). */
const AS_PAGE_URL = `${FIXTURE_URL}${AS_PAGE_SCRIPT_URL}`
const CONTEXT_ORIGIN = 'https://example.com'

const TEST_TIMEOUT_MS = 150_000

let staticServer: ChildProcess

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  await waitForTcpReady(HOST, STATIC_PORT, 10_000)
}, 15_000)

afterAll(async () => {
  await killChild(staticServer)
  expect(await assertNoElectronSurvivors()).toEqual([])
})

function testManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.web-context-e2e',
    name: 'Orivon web-context e2e fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { web: { contexts: [CONTEXT_ORIGIN] } }
  }
}

it(
  '[app:web-context-open-evaluate-close] opens an isolated context at the granted origin, with no orivon.*, no cookies, an ungranted fetch refused, ' +
  'navigation refused, a reopened partition empty, a context still served after a main-process garbage collection, ' +
  'and revocation rejecting a pending closed with \'revoked\'',
  async () => {
    await runPhase('web.context e2e', async (check) => {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, {
          origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'web.context', patterns: [CONTEXT_ORIGIN]
        } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
          grantOutcome.installed,
          grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        const grantId = grantOutcome.grant.id

        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

        // ---- (1) origin / no orivon.* / no cookies / an ungranted fetch / navigation refusal.
        const basics = await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const orivon = (window as unknown as {
            orivon: { web: { openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<{
              id: string
              evaluate: (script: string) => Promise<unknown>
              close: () => Promise<void>
            }> } }
          }).orivon
          const context = await orivon.web.openContext('https://example.com')

          const originResult = await context.evaluate('location.origin')
          const orivonType = await context.evaluate('typeof orivon')
          const cookie = await context.evaluate('document.cookie')
          // No https.connect grant exists for the opener at all -- refused
          // by authoriseReachFor before any dial, so this needs no real
          // network access.
          const fetchResult = await context.evaluate(
            'fetch(\'https://example.com/\').then(r => ({status: r.status})).catch(e => ({threw: String(e && e.message)}))'
          )
          await context.evaluate('location.href = \'https://not-example.invalid/\'')
          await new Promise((resolve) => { setTimeout(resolve, 300) })
          const originAfterNavigate = await context.evaluate('location.origin')

          await context.close()
          return { originResult, orivonType, cookie, fetchResult, originAfterNavigate }
        })

        check('location.origin inside the context is the granted origin', basics.originResult === 'https://example.com', JSON.stringify(basics))
        check('typeof orivon inside the context is undefined -- no preload ran there', basics.orivonType === 'undefined', JSON.stringify(basics))
        check('document.cookie inside the context is empty -- an empty partition', basics.cookie === '', JSON.stringify(basics))
        check(
          'a fetch to a host the opener holds no https.connect grant for is refused (404), never a successful response',
          (basics.fetchResult as { status?: number }).status === 404,
          JSON.stringify(basics)
        )
        check(
          'navigating the context away is refused -- location.origin is unchanged after the attempt',
          basics.originAfterNavigate === 'https://example.com',
          JSON.stringify(basics)
        )

        // ---- (2) the partition is empty on reopen (localStorage set before, gone after).
        const reopen = await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const orivon = (window as unknown as {
            orivon: { web: { openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<{
              evaluate: (script: string) => Promise<unknown>
              close: () => Promise<void>
            }> } }
          }).orivon

          const first = await orivon.web.openContext('https://example.com')
          await first.evaluate('localStorage.setItem(\'orivon-e2e\', \'set-before-close\'); \'ok\'')
          const before = await first.evaluate('localStorage.getItem(\'orivon-e2e\')')
          await first.close()

          const second = await orivon.web.openContext('https://example.com')
          const after = await second.evaluate('localStorage.getItem(\'orivon-e2e\')')
          await second.close()

          return { before, after }
        })

        check('localStorage set before close is readable within that same context', reopen.before === 'set-before-close', JSON.stringify(reopen))
        check('the partition is empty after a close-and-reopen -- localStorage is gone', reopen.after === null, JSON.stringify(reopen))

        // ---- (3) a context is still served after the main process collects garbage.
        // Only the host's own record keeps a context's view alive. Collecting the view
        // destroys the context, which is timing-dependent in ordinary use, so this forces
        // a full collection between opening the context and using it.
        await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const orivon = (window as unknown as {
            orivon: { web: { openContext: (origin: string) => Promise<unknown> } }
          }).orivon
          ;(window as unknown as { __orivonE2eContext: unknown }).__orivonE2eContext = await orivon.web.openContext('https://example.com')
          return true
        })
        // getBuiltinModule, not require or import(): main may be bundled as
        // ESM, where there is no require, and vitest rewrites import() in a
        // function it hands to app.evaluate.
        await app.evaluate(() => {
          process.getBuiltinModule('node:v8').setFlagsFromString('--expose-gc')
          ;(process.getBuiltinModule('node:vm').runInNewContext('gc') as () => void)()
        })
        const afterGc = await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const context = (window as unknown as { __orivonE2eContext: {
            evaluate: (script: string) => Promise<unknown>
            close: () => Promise<void>
          } }).__orivonE2eContext
          const fetchResult = await context.evaluate(
            'fetch(\'https://example.com/\').then(r => ({status: r.status})).catch(e => ({threw: String(e && e.message)}))'
          )
          await context.close()
          return fetchResult
        })
        check(
          'a context opened before a main-process garbage collection still gets its refused fetch answered (404)',
          (afterGc as { status?: number }).status === 404,
          JSON.stringify(afterGc)
        )

        // ---- (4) revoking the grant rejects a PENDING closed with 'revoked'.
        await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const orivon = (window as unknown as {
            orivon: { web: { openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<{
              closed: Promise<void>
            }> } }
          }).orivon
          const context = await orivon.web.openContext('https://example.com')
          ;(window as unknown as { __orivonE2eClosed: Promise<{ rejected: boolean, code: string | undefined }> }).__orivonE2eClosed =
            context.closed.then(() => ({ rejected: false, code: undefined }))
              .catch((e: { code?: string }) => ({ rejected: true, code: e?.code }))
          return true
        })

        const revokeOutcome = await app.evaluate(async (_electron, args: { origin: string, grantId: string }) => {
          const hook = (globalThis as unknown as { __orivonDevRevoke?: (origin: string, grantId: string) => Promise<void> }).__orivonDevRevoke
          if (typeof hook !== 'function') return { installed: false as const }
          await hook(args.origin, args.grantId)
          return { installed: true as const }
        }, { origin: FIXTURE_ORIGIN, grantId })
        check(
          'the developer-only revoke hook is installed in this build',
          revokeOutcome.installed,
          revokeOutcome.installed ? undefined : 'globalThis.__orivonDevRevoke was not a function in the main process'
        )

        const closedOutcome = await evaluateRetrying(view, async () =>
          await (window as unknown as { __orivonE2eClosed: Promise<{ rejected: boolean, code: string | undefined }> }).__orivonE2eClosed
        )
        check(
          'the pending closed promise rejects with \'revoked\' once the grant is withdrawn',
          closedOutcome.rejected && closedOutcome.code === 'revoked',
          JSON.stringify(closedOutcome)
        )

        // ---- (5) pins the contract's own positional-origin shape (capability-api.ts's
        // `openContext(origin: string, options?: WebContextOptions)`): a WRONG,
        // single-object call must be refused, not silently accepted as
        // `{ origin: undefined }`.
        const wrongShape = await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const orivon = (window as unknown as {
            orivon: { web: { openContext: (origin: unknown, options?: { width?: number, height?: number }) => Promise<unknown> } }
          }).orivon
          try {
            await orivon.web.openContext({ origin: 'https://example.com' })
            return { rejected: false, code: undefined as string | undefined }
          } catch (e) {
            return { rejected: true, code: (e as { code?: string } | null)?.code }
          }
        })
        check(
          'openContext called with the old, wrong { origin } object shape is refused with \'invalid\', not silently accepted',
          wrongShape.rejected && wrongShape.code === 'invalid',
          JSON.stringify(wrongShape)
        )
      } finally {
        clearFixtureAsPageScript()
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
