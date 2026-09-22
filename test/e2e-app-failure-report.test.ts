// The shell tells someone when an app tab dies on its own.
//
// An app whose bundle throws while its module graph is still evaluating
// renders nothing, and the throw stays inside the renderer -- so the symptom
// is a blank window and an empty terminal. That is what made ADR-0021's own
// case expensive: one non-writable property descriptor, found by hand,
// because nothing anywhere named a cause. src/main/tab-view.ts's
// `reportAppFailures` closes that, and this file is the proof it still does.
//
// TWO HALVES, and the second matters as much as the first. Every website on
// the open web logs errors constantly, so a browser that narrated them all
// would bury the one case anybody is debugging. The report is therefore
// bound to the `--orivon-app-tab` flag, and this file asserts the silence as
// well as the noise -- against the SAME origin and the same thrown error,
// before and after the grant, so nothing but the flag differs between them.
//
// Hermetic: one loopback static server, no network.
import { afterAll, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, mainOutput, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, findViewShowing, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, killChild, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { PORT_APP_FREETUBE, startOwnServer, grantOriginOnly, readAppManifest } from './freetube-fixture.js'

const ORIGIN = `http://127.0.0.1:${String(PORT_APP_FREETUBE)}`

/** How long an ordinary tab's error is given to NOT appear. A report is
 * written synchronously when Electron fires `console-message`, so this only
 * has to outlast the event's own trip from the renderer. */
const SILENCE_SETTLE_MS = 2_000

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 4 + 8_000 * 8 + APP_CLOSE_RACE_MS + 40_000

/** Appends a module script that throws while evaluating -- the shape of the
 * failure this exists for, not a plain `console.error` that would prove far
 * less. Built as source text because it is handed to `page.evaluate`. */
const throwInPage = (message: string): string => `
  const script = document.createElement('script')
  script.type = 'module'
  script.textContent = 'throw new TypeError(' + ${JSON.stringify(JSON.stringify(message))} + ')'
  document.body.append(script)
`

const ORDINARY = 'ORDINARY TAB ERROR, must stay unreported'
const APP = "Cannot assign to read only property 'fetch' of object '#<Window>'"

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it(
  'the shell reports an app tab that dies evaluating a module, and stays quiet for an ordinary one',
  async () => {
    await runPhase('app-failure-report', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let server: ChildProcess | undefined
      try {
        server = await startOwnServer(
          'freetube-server',
          join(process.cwd(), 'test', 'apps', 'freetube', 'serve.mjs'),
          ['--port', String(PORT_APP_FREETUBE)]
        )
        app = await launchElectron({ appPath: '.' })
        await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)

        // ---- An ordinary tab: this origin, before anything is granted ----
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
        await waitForTab(chrome, { address: `${ORIGIN}/`, title: 'FreeTube for Orivon' })
        const plain = findViewShowing(app, chrome, `${ORIGIN}/`)
        if (plain === undefined) throw new Error('no view showing the origin before the grant')

        await plain.evaluate(throwInPage(ORDINARY))
        await new Promise((resolve) => setTimeout(resolve, SILENCE_SETTLE_MS))
        const quiet = !mainOutput(app).includes(ORDINARY)
        check(
          'AN ORDINARY TAB IS NOT NARRATED: the open web logs errors constantly, and reporting them would bury the one case being debugged',
          quiet,
          quiet ? undefined : mainOutput(app).slice(-800)
        )

        // ---- The same origin, now granted, so its view carries the flag --
        const manifest = await readAppManifest()
        const granted = await grantOriginOnly(app.evaluate.bind(app), manifest, ORIGIN)
        if (!granted.hooksPresent) throw new Error('dev grant hook missing -- build with node scripts/build-e2e.mjs')

        // A distinct path, so this is a fresh WebContentsView built AFTER the
        // grant: the app-tab flag is fixed at construction (ADR-0017), so
        // reusing the first view would test the ungranted answer twice.
        await clickAddressBarRetrying(chrome, `${ORIGIN}/?app`)
        await waitFor(() => findViewShowing(app as NonNullable<typeof app>, chrome, `${ORIGIN}/?app`) !== undefined, 15_000)
        const appTab = findViewShowing(app, chrome, `${ORIGIN}/?app`)
        if (appTab === undefined) throw new Error('no app-tab view after the grant')

        const routed = await appTab.evaluate(() => !/\[native code\]/.test(String(globalThis.fetch)))
        check('the second view really is a registered app tab, so the two halves differ only by the flag', routed)

        await appTab.evaluate(throwInPage(APP))
        const seen = await waitFor(
          () => mainOutput(app as NonNullable<typeof app>).includes(`[orivon][app ${ORIGIN}/?app]`) &&
            mainOutput(app as NonNullable<typeof app>).includes(APP),
          15_000
        )
        const line = mainOutput(app).split('\n').find((l) => l.includes('[orivon][app')) ?? '(nothing reported)'
        check(
          `AN APP TAB IS: ${line.replace('[main] ', '').trim()}`,
          seen,
          seen ? undefined : mainOutput(app).slice(-1500)
        )
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        if (server !== undefined) await killChild(server)
      }
    })
  },
  TEST_TIMEOUT_MS
)
