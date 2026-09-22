// The developer-mode discovery path, on an ORDINARY build -- no
// `scripts/build-e2e.mjs`, no `__orivonDevGrant`, no test-injected grant.
// Exactly what `npm run dev` runs.
//
// Navigating to a loopback origin whose page carries a
// `<link rel="orivon-manifest">` hint must fetch that manifest, prompt, and
// on acceptance grant the capabilities TO THE ORIGIN -- with nothing
// installed: no bundle fetch, no hash pin, no cached serving. The page keeps
// being served by the plain static server that hosts it.
//
// THE ONE THING THIS SUBSTITUTES is the click. `install-consent-prompt.ts`
// raises a real native `dialog.showMessageBox`, which no driver here can
// press, so the test replaces that one method in the main process with one
// that answers "allow" -- the same privilege level Playwright's `evaluate`
// already has, and nothing the shell itself would ever do. Every other step
// is the shipped code path.
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
//   ORIVON_ORDINARY_BUILD=1 npx vitest run --config test/vitest.e2e.config.ts test/e2e-dev-origin-grant.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying, findChrome, findViewShowing, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, killChild, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { PORT_APP_FREETUBE, startOwnServer } from './freetube-fixture.js'

const ORDINARY_BUILD = process.env['ORIVON_ORDINARY_BUILD'] === '1'

const HOST = '127.0.0.1'
const PORT = PORT_APP_FREETUBE
const ORIGIN = `http://${HOST}:${PORT}`

afterAll(async () => {
  if (!ORDINARY_BUILD) return
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + 8_000 * 6 + APP_CLOSE_RACE_MS + 30_000

it.skipIf(!ORDINARY_BUILD)(
  'visiting a loopback origin that advertises a manifest prompts, grants the URL, and turns the tab into an app tab -- on a plain build, with nothing installed',
  async () => {
    await runPhase('dev-origin-grant', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let server: ChildProcess | undefined
      try {
        server = await startOwnServer('freetube-server', join(process.cwd(), 'test', 'apps', 'freetube', 'serve.mjs'), ['--port', String(PORT)])
        check('a plain static file server is serving test/apps/freetube/, executing no logic of its own', true)

        // The opt-in `npm run dev` sets. Without it this hint takes the
        // install path and A46 refuses the loopback origin outright --
        // e2e-app-loader-journey.test.ts asserts exactly that default.
        app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_DEV_ORIGINS: '1' } })

        const hooksAbsent = await app.evaluate(() => {
          const globals = globalThis as unknown as { __orivonDevGrant?: unknown, __orivonDevRegisterServing?: unknown }
          return globals.__orivonDevGrant === undefined && globals.__orivonDevRegisterServing === undefined
        })
        check('ORDINARY BUILD: neither dev-only test hook exists in this process', hooksAbsent)

        // Answer the real consent dialog "allow". Everything upstream and
        // downstream of this one method is the shipped path.
        const prompted = { count: 0 }
        await app.evaluate(({ dialog }) => {
          const globals = globalThis as unknown as { __promptCount?: number }
          globals.__promptCount = 0
          dialog.showMessageBox = (async () => {
            globals.__promptCount = (globals.__promptCount ?? 0) + 1
            return { response: 0, checkboxChecked: false }
          }) as unknown as typeof dialog.showMessageBox
        })

        await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)

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

        prompted.count = await app.evaluate(() => (globalThis as unknown as { __promptCount?: number }).__promptCount ?? 0)
        check(`the real consent dialog was raised (${String(prompted.count)} prompt(s))`, prompted.count > 0)
        check(
          'ACCEPTING THE PROMPT MAKES THE TAB AN APP TAB: window.fetch is not the platform\'s own, so the routed fetch is installed, from a plain http loopback URL, with nothing installed to disk',
          becameAppTab,
          becameAppTab ? undefined : JSON.stringify(pageState)
        )

        const view = findViewShowing(app, chrome, `${ORIGIN}/`)
        if (view === undefined) throw new Error('no view showing the origin after the grant')

        // A subframe gets no preload of its own -- `nodeIntegrationInSubFrames`
        // is unset, and a hookify rule blocks setting it. That is what this
        // asserts, and enabling it would fail here, flagging the change.
        //
        // It does NOT assert that the child is cut off: a same-origin child
        // reaches `parent.orivon` by the web's own same-origin policy, and the
        // call is correctly attributed to the parent's frame because it runs
        // the parent's preload closure. That is the web working, not an Orivon
        // property, so it is reported in the label rather than asserted.
        const reachThrough = await view.evaluate(async () => {
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
        const grants = await evaluateRetrying(view, async () => {
          const orivon = (globalThis as unknown as { orivon: { app: { grants: () => Promise<Array<{ capability: string }>> } } }).orivon
          return (await orivon.app.grants()).map((g) => g.capability)
        })
        check(`the origin holds what its manifest declared: ${JSON.stringify(grants)}`, grants.includes('https.connect'))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        if (server !== undefined) await killChild(server)
      }
    })
  },
  TEST_TIMEOUT_MS
)
