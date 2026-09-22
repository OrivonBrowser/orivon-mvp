// End-to-end proof that S4-6's CSP (src/broker/policy/connect-src.ts, wired
// in src/loader/serve.ts) is enforced by CHROMIUM ITSELF against the served
// bundle's own document -- not merely computed correctly (src/broker/
// policy/tests/connect-src.test.ts already proves that) and not merely
// reflected in a header string (src/loader/tests/serve.test.ts and
// src/loader/tests/electron-serve.test.ts already prove that too, against a
// stub session). None of those three prove the browser actually refuses a
// non-granted connection because of it, which is the one thing a real
// Electron launch can prove and a unit test cannot.
//
// WHY XMLHttpRequest, NOT fetch(). ADR-0017's routed fetch()
// (src/preload/fetch-route.ts) overrides `window.fetch` for a registered
// app's tab and answers a cross-origin request over a broker-checked raw
// TCP socket instead of Chromium's own networking stack -- so a fetch()
// failure there would prove the BROKER's own `tcp.connect` grant check, not
// CSP, exactly the confusion this file exists to avoid. `installFetchRoute`
// never touches `XMLHttpRequest`, and `connect-src` governs XHR identically
// to fetch() per the CSP spec -- so granting a capability via the ordinary,
// already-audited `__orivonDevGrant` hook (which also registers the app,
// activating the fetch-route shim) cannot contaminate an XHR-based
// assertion the way it would a fetch()-based one.
//
// THE SIGNAL: a `securitypolicyviolation` DOM event. Chromium fires it
// exactly when a request is refused BY CSP, and never otherwise -- so its
// presence or absence on `document` is what separates "Chromium's CSP
// engine blocked this" from "the request failed for some other reason".
// MEASURED, NOT ASSUMED: a granted host does not fail at DNS the way an
// ordinary external host would under HERMETIC_RESOLVER -- this app's own
// `protocol.handle` intercepts the WHOLE https scheme for its partition
// (A143), so once CSP lets a request past, it reaches THIS app's own
// serve.ts handler next, answering a real 404 rather than a network error.
// See the granted-host check below for the full account.
//
// RUN THIS WITH: npm run test:e2e, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-csp-connect-src.test.ts
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/node-storage.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

// `.test` -- IANA-reserved, never resolvable -- same convention as
// e2e-serve-from-cache.test.ts and spike/adr7-probe/'s own PROBE_ORIGIN.
const ORIGIN = 'https://csp-connect-src-e2e.orivon.test'
/** Named in this origin's own `tcp.connect` grant -- CSP must widen to admit it. */
const GRANTED_HOST = 'granted.csp-connect-src-e2e.orivon.test'
/** Named nowhere -- CSP must refuse it, and ONLY it should raise a violation. */
const UNGRANTED_HOST = 'not-granted.csp-connect-src-e2e.orivon.test'
const GRANT_PATTERN = `${GRANTED_HOST}:443`

const INDEX_HTML = '<!doctype html><html><head><title>csp-connect-src fixture</title></head><body><h1>csp fixture</h1></body></html>'
const MANIFEST_JSON = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.csp-connect-src-e2e',
  name: 'CSP connect-src e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: {}
})

/** A real, valid pin -- same construction install() itself uses (`bundleTree`/
 * `fromBundleTree`), written directly via node-storage.ts from the test
 * process, matching e2e-serve-from-cache.test.ts's own approach and for the
 * same reason (install-origin.ts's https/public-unicast-only rule has no
 * exception a hermetic `.test` origin could ever satisfy). */
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

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

it(
  'Chromium itself refuses an XHR to a host outside the served bundle\'s connect-src, and raises a securitypolicyviolation for it -- while an XHR to a granted host raises none',
  async () => {
    await runPhase('csp connect-src enforcement', async (check) => {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
        await pinFixture(userDataDir)

        // ---- Grant tcp.connect for GRANTED_HOST, via the real, audited ----
        // dev-only hook -- the SAME broker instance this launch's own IPC is
        // wired to (src/main/dev-grant.ts). This also calls registerApp(),
        // which makes this tab an "app tab" and activates the fetch-route
        // shim -- irrelevant here, since this file never calls fetch().
        const manifest: Manifest = {
          orivonApiVersion: 0,
          id: 'app.orivon.csp-connect-src-e2e',
          name: 'CSP connect-src e2e fixture',
          version: '1.0.0',
          entry: 'index.html',
          capabilities: { net: { tcp: { connect: [GRANT_PATTERN] } } }
        }
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: ORIGIN, manifest, capability: 'tcp.connect', patterns: [GRANT_PATTERN] } satisfies DevGrantRequest)
        check(
          'the developer-only grant hook is installed in this build (npm run test:e2e builds with ORIVON_ENABLE_DEV_GRANT=1)',
          grantOutcome.installed,
          grantOutcome.installed ? undefined : 'globalThis.__orivonDevGrant was not a function in the main process'
        )
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        // ---- Register serving for real, through the dev-only hook --------
        // Read fresh per request (S4-6): granting BEFORE or AFTER this call
        // makes no difference to the CSP the resulting handler emits.
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

        const view = await navigateToFixture(app, `${ORIGIN}/`, 'csp-connect-src fixture')

        // ---- The header itself really is on the document's own response --
        // a same-origin fetch() is never intercepted by the routing shim
        // (fetch-route.ts's own `crossOrigin` check), so this reads the
        // REAL response Chromium itself received and is enforcing.
        const cspHeader = await evaluateRetrying(view, async () => (await fetch('/')).headers.get('content-security-policy'))
        check(
          'the served document\'s own response carries a connect-src naming the granted host, and no other',
          typeof cspHeader === 'string' &&
            cspHeader.includes(`connect-src 'self' ${GRANTED_HOST}:443`) &&
            !cspHeader.includes(UNGRANTED_HOST),
          String(cspHeader)
        )

        // ---- THE ENFORCEMENT PROOF -----------------------------------
        // NO REFERENCE TO THE OUTER GRANTED_HOST/UNGRANTED_HOST CONSTS
        // INSIDE THIS CALLBACK -- evaluateRetrying's page.evaluate(fn) sends
        // `fn` across to the page by source text alone (smoke-helpers.mjs's
        // own evaluateRetrying takes no `arg`), so a closure over anything
        // outside this function's own body would reference an undefined
        // identifier once it runs there. The two literals below are
        // duplicated from this file's own consts on purpose, matching
        // fetch-route.ts's identical constraint on `installFetchRoute`.
        const result = await evaluateRetrying(view, async () => {
          const grantedUrl = 'https://granted.csp-connect-src-e2e.orivon.test/'
          const ungrantedUrl = 'https://not-granted.csp-connect-src-e2e.orivon.test/'

          const violations: Array<{ directive: string, blockedURI: string }> = []
          const onViolation = (e: SecurityPolicyViolationEvent): void => {
            violations.push({ directive: e.violatedDirective, blockedURI: e.blockedURI })
          }
          document.addEventListener('securitypolicyviolation', onViolation)

          function xhr (url: string): Promise<{ ok: boolean, status: number }> {
            return new Promise((resolve) => {
              try {
                const req = new XMLHttpRequest()
                req.open('GET', url)
                req.onload = () => { resolve({ ok: true, status: req.status }) }
                req.onerror = () => { resolve({ ok: false, status: req.status }) }
                req.send()
              } catch {
                // A CSP refusal is not documented as always asynchronous --
                // if it throws synchronously instead, that is still "refused",
                // not a harness bug.
                resolve({ ok: false, status: 0 })
              }
            })
          }

          const grantedResult = await xhr(grantedUrl)
          // A settling delay: CSP's own violation event and the request's
          // terminal event are not documented as strictly ordered relative
          // to each other, so this gives a same-tick violation a moment to
          // land before it is read below.
          await new Promise((resolve) => setTimeout(resolve, 50))
          const violationsAfterGranted = violations.length

          const ungrantedResult = await xhr(ungrantedUrl)
          await new Promise((resolve) => setTimeout(resolve, 50))
          const violationsAfterUngranted = violations.slice(violationsAfterGranted)

          document.removeEventListener('securitypolicyviolation', onViolation)
          return { grantedResult, ungrantedResult, violationsAfterGranted, violationsAfterUngranted }
        }, 15_000)

        // MEASURED, NOT ASSUMED (found running this file against a real
        // launch): the granted host does NOT fail at DNS under
        // HERMETIC_RESOLVER the way an ordinary external host would. This
        // app's own `protocol.handle('https', ...)` intercepts the WHOLE
        // scheme for its partition, not merely its own origin (A143,
        // docs/open-questions.md) -- so once CSP lets the attempt past
        // (proven by the zero-violations check below), it never reaches
        // real DNS at all: it reaches THIS SAME app's own serve.ts handler,
        // which denies it as cross-origin with a real 404. That is a
        // correct, already-filed, separate behaviour, not a gap this test
        // should paper over by asserting something false about it.
        check(
          'an XHR to the GRANTED host resolves to A143\'s own cross-origin-in-partition 404 -- reached this app\'s OWN protocol handler, never a real network response, because nothing outside this partition can answer it',
          result.grantedResult.ok && result.grantedResult.status === 404,
          JSON.stringify(result.grantedResult)
        )
        check(
          'the GRANTED host raises NO securitypolicyviolation -- CSP let the attempt past its own engine; A143\'s in-partition denial that catches it next is a separate mechanism',
          result.violationsAfterGranted === 0,
          JSON.stringify(result.violationsAfterGranted)
        )
        check(
          'an XHR to the UNGRANTED host is refused before ever reaching that far -- CSP blocks it synchronously, so it never even reaches A143\'s in-partition interception the granted host above ran into',
          !result.ungrantedResult.ok,
          JSON.stringify(result.ungrantedResult)
        )
        check(
          'the UNGRANTED host raises a real connect-src violation -- this is Chromium\'s OWN CSP engine refusing it, not a broker decision the page never asked (this file uses XHR precisely because ADR-0017\'s routed fetch() would otherwise make this ambiguous)',
          result.violationsAfterUngranted.length > 0 && result.violationsAfterUngranted.every((v: { directive: string }) => v.directive.startsWith('connect-src')),
          JSON.stringify(result.violationsAfterUngranted)
        )
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
