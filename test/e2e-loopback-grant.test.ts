// The loopback discovery path, on an ORDINARY build with developer mode
// OFF -- no `scripts/build-e2e.mjs`, no `__orivonDevGrant`, no test-injected
// grant, no `ORIVON_DEV_ORIGINS`. Exactly what `npm start` runs.
//
// Navigating to a loopback origin whose page carries a
// `<link rel="orivon-manifest">` hint must fetch that manifest, prompt, and
// on acceptance grant the capabilities TO THE ORIGIN -- with nothing
// installed: no bundle fetch, no hash pin, no cached serving. The page keeps
// being served by the plain static server that hosts it.
//
// Nothing is substituted. `install-consent-prompt.ts` asks in the question
// panel of the tab, and the test presses its real accepting button after the
// guard, the way a person does. The native dialog methods are replaced with
// recorders only to prove none was opened.
//
// Hermetic: everything it touches is loopback.
//
// SKIPPED UNLESS `ORIVON_ORDINARY_BUILD=1`, and that is not a convenience
// flag. This file asserts the dev-only test hooks are ABSENT, which is only
// true of an ordinary build -- and `npm run test:e2e` builds with them
// present, on purpose, because every other e2e file needs them. The two
// builds cannot coexist in one run, so this one names the build it requires
// instead of silently passing against the wrong one.
//
// RUN THIS WITH:
//   node scripts/build-ordinary.mjs
//   ORIVON_ORDINARY_BUILD=1 npx vitest run --config test/vitest.e2e.config.ts test/e2e-loopback-grant.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, findChrome, findViewShowing, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, asPage, clickAddressBarRetrying, closeElectronApp, killChild, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { AS_PAGE_SCRIPT_URL, PORT_APP_FREETUBE, clearFreetubeAsPageScript, setFreetubeAsPageScript, startOwnServer } from './freetube-fixture.js'
import { answerAccepting, noNativeDialogs, stubNativeDialogs } from './question-support.js'

const ORDINARY_BUILD = process.env['ORIVON_ORDINARY_BUILD'] === '1'

const HOST = '127.0.0.1'
const PORT = PORT_APP_FREETUBE
const ORIGIN = `http://${HOST}:${PORT}`

afterAll(async () => {
  if (!ORDINARY_BUILD) return
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + 8_000 * 8 + APP_CLOSE_RACE_MS + 30_000

it.skipIf(!ORDINARY_BUILD)(
  '[app:loopback-manifest-hint-grants-the-origin] visiting a loopback origin that advertises a manifest prompts, grants the URL, and turns the tab into an app tab -- on a plain build, with nothing installed',
  async () => {
    await runPhase('loopback-grant', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let server: ChildProcess | undefined
      try {
        server = await startOwnServer('freetube-server', join(process.cwd(), 'test', 'apps', 'freetube', 'serve.mjs'), ['--port', String(PORT)])
        check('a plain static file server is serving test/apps/freetube/, executing no logic of its own', true)

        // Developer mode forced off, whatever the calling shell exports: a
        // loopback origin must prompt without it.
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_DEV_ORIGINS: '0' } })

        const hooksAbsent = await app.evaluate(() => {
          const globals = globalThis as unknown as { __orivonDevGrant?: unknown, __orivonDevRegisterServing?: unknown }
          return globals.__orivonDevGrant === undefined && globals.__orivonDevRegisterServing === undefined
        })
        check('ORDINARY BUILD: neither dev-only test hook exists in this process', hooksAbsent)

        await stubNativeDialogs(app)

        await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)

        // The question is drawn in the tab's own panel, and accepting it is
        // the last thing a person has to do.
        const asked = await answerAccepting(app)

        // ONE navigation, one prompt, no second address-bar entry: accepting
        // the prompt must be the last thing a person has to do.
        const becameAppTab = await waitFor(async () => {
          const view = findViewShowing(app as NonNullable<typeof app>, chrome, `${ORIGIN}/`)
          if (view === undefined) return false
          try {
            // The tell: the routed fetch is an ordinary JS function, while
            // a native one reports [native code]. That is all it claims --
            // the routed binding carries the platform's own descriptor.
            return await view.evaluate(() => !/\[native code\]/.test(String(globalThis.fetch)))
          } catch {
            // The view is swapped out mid-repartition; poll again.
            return false
          }
        }, 25_000)

        // Read for the failure message only: when the tab never becomes an
        // app tab, whether `fetch` is still the native one and which banner
        // the app chose to show is what separates "no grant" from "granted,
        // but the view was never rebuilt with the app-tab flag".
        const viewNow = findViewShowing(app, chrome, `${ORIGIN}/`)
        const pageState = viewNow === undefined
          ? { missing: true }
          : await viewNow.evaluate(() => ({
            hasOrivon: typeof (globalThis as { orivon?: unknown }).orivon === 'object',
            fetchSource: String(globalThis.fetch).slice(0, 60),
            banner: document.querySelector('.notice strong')?.textContent ?? '(no banner)'
          }))

        check(`the consent question was asked in the panel, naming the app's origin: ${JSON.stringify(asked.origin)}`, asked.buttons.some((label) => label.startsWith('Allow')) && asked.origin.includes(`127.0.0.1:${String(PORT)}`))
        check('no native message box was opened for it', (await noNativeDialogs(app)).length === 0, JSON.stringify(await noNativeDialogs(app)))
        check(
          'ACCEPTING THE PROMPT MAKES THE TAB AN APP TAB: window.fetch is not the platform\'s own, so the routed fetch is installed, from a plain http loopback URL, with nothing installed to disk',
          becameAppTab,
          becameAppTab ? undefined : JSON.stringify(pageState)
        )

        const view = findViewShowing(app, chrome, `${ORIGIN}/`)
        if (view === undefined) throw new Error('no view showing the origin after the grant')

        // `window.orivon` answers only a call made by a script the page itself loaded (ADR-0045), so each
        // call below goes through asPage (e2e-helpers.ts): a real `<script src>` served from this
        // fixture's own static root, never page.evaluate().
        const asPageUrl = `${ORIGIN}/${AS_PAGE_SCRIPT_URL}`

        // A subframe's preload installs the page-dialog wrapper and nothing
        // else (src/preload/frame.ts): no `window.orivon`. That is what this
        // asserts, and a subframe that gained the surface would fail here.
        //
        // It does NOT assert that the child is cut off: a same-origin child
        // reaches `parent.orivon` by the web's own same-origin policy, and the
        // call is correctly attributed to the parent's frame because it runs
        // the parent's preload closure. That is the web working, not an Orivon
        // property, so it is reported in the label rather than asserted.
        const reachThrough = await asPage(view, setFreetubeAsPageScript, asPageUrl, async () => {
          const frame = document.createElement('iframe')
          frame.src = '/index.html'
          document.body.append(frame)
          await new Promise((resolve) => { frame.addEventListener('load', resolve, { once: true }) })
          const child = frame.contentWindow as unknown as { parent: { orivon?: { app?: { grants: () => Promise<unknown[]> } } }, orivon?: unknown }
          const ownSurface = typeof child.orivon
          let viaParent: string
          try {
            const grants = await child.parent.orivon!.app!.grants()
            viaParent = `CALLED, ${String((grants as unknown[]).length)} grants returned`
          } catch (error) {
            viaParent = `refused: ${error instanceof Error ? error.message : String(error)}`
          }
          return { ownSurface, viaParent }
        })
        check(
          `a subframe gets no orivon surface of its own (via window.parent, by same-origin policy: ${reachThrough.viaParent})`,
          reachThrough.ownSurface === 'undefined',
          `typeof child.orivon was ${reachThrough.ownSurface}`
        )
        const grants = await asPage(view, setFreetubeAsPageScript, asPageUrl, async () => {
          const orivon = (globalThis as unknown as { orivon: { app: { grants: () => Promise<Array<{ capability: string }>> } } }).orivon
          return (await orivon.app.grants()).map((g) => g.capability)
        })
        check(`the origin holds what its manifest declared: ${JSON.stringify(grants)}`, grants.includes('https.connect'))

        // ---- A grant alone does not isolate an origin -- the tab stays on
        // the shell's shared default session, and the CSP its grants earn is
        // appended by the default session's ONE onHeadersReceived handler
        // (../src/main/install/granted-origin-csp.ts). ----
        const onDefaultSession = await app.evaluate(({ webContents, session }, url: string) => {
          const wc = webContents.getAllWebContents().find((c) => c.getURL() === url)
          return wc === undefined ? undefined : wc.session === session.defaultSession
        }, `${ORIGIN}/`)
        check('the granted tab runs on the shell\'s shared default session, not a partition of its own', onDefaultSession === true)

        // The CSP this handler appends is DOCUMENT-only (granted-origin-csp.ts's
        // own header: "so a worker from that server carries none"), so a
        // fresh fetch('/') from the page -- an xhr/fetch resourceType, not a
        // document -- never carries it back on its OWN response and cannot
        // prove anything. XMLHttpRequest instead, never the ADR-0017 routed
        // fetch this app tab's own window.fetch now is (this file's own
        // "ACCEPTING THE PROMPT..." check above), the same substitution
        // e2e-csp-connect-src.test.ts's header explains: connect-src governs
        // XHR identically to fetch() per the CSP spec, so a securitypolicy-
        // violation event on an XHR to a host outside the grant's
        // connect-src is Chromium enforcing the appended document CSP.
        const cspEnforced = await evaluateRetrying(view, async () => {
          const violations: string[] = []
          const onViolation = (e: SecurityPolicyViolationEvent): void => { violations.push(e.violatedDirective) }
          document.addEventListener('securitypolicyviolation', onViolation)

          await new Promise<{ ok: boolean, status: number }>((resolve) => {
            try {
              const req = new XMLHttpRequest()
              req.open('GET', 'https://not-granted-by-this-manifest.invalid/')
              req.onload = () => { resolve({ ok: true, status: req.status }) }
              req.onerror = () => { resolve({ ok: false, status: req.status }) }
              req.send()
            } catch {
              // A CSP refusal is not documented as always asynchronous -- if
              // it throws synchronously instead, that is still "refused".
              resolve({ ok: false, status: 0 })
            }
          })
          // A settling delay: CSP's own violation event and the request's
          // terminal event are not documented as strictly ordered relative
          // to each other (e2e-csp-connect-src.test.ts's own comment).
          await new Promise((resolve) => setTimeout(resolve, 50))

          document.removeEventListener('securitypolicyviolation', onViolation)
          return violations
        }, 15_000)
        check(
          `the appended grant CSP is enforced on this document: an XHR to a host outside the granted connect-src ` +
          `is refused by CSP, not merely by the resolver (saw ${JSON.stringify(cspEnforced)})`,
          cspEnforced.includes('connect-src')
        )
      } finally {
        clearFreetubeAsPageScript()
        if (app !== undefined) await closeElectronApp(app)
        if (server !== undefined) await killChild(server)
      }
    })
  },
  TEST_TIMEOUT_MS
)
