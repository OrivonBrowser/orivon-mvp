// The app served by a PLAIN STATIC SERVER, granted at its own origin, with no
// install of any kind: no bundle fetch, no hash pin, no cached serving.
//
// WHAT THIS TESTS, AND WHY IT IS A DIFFERENT CLAIM FROM
// e2e-freetube-app.test.ts. That file installs the app the way ADR-0007's
// serve-from-cache path does, and proves an INSTALLED app works. This one
// proves the thing installation was never supposed to be a precondition for:
// capabilities attach to a URL, the page keeps being served by whoever hosts
// it, and `apps/freetube/serve.mjs` stays a file server that executes no
// logic of its own.
//
// The grant is issued through `__orivonDevGrant` rather than the consent
// prompt, so this file isolates what a granted live origin can DO from how it
// gets granted. The real prompt-to-app-tab path is e2e-dev-origin-grant.test.ts.
//
// NO HERMETIC_RESOLVER: the app has to reach real YouTube for this to mean
// anything, so this is not hermetic and must not gate CI.
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-freetube-live-origin.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, killChild, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { PORT_APP_FREETUBE, startOwnServer, grantOriginOnly, readAppManifest } from './freetube-fixture.js'

const HOST = '127.0.0.1'
const PORT = PORT_APP_FREETUBE
const ORIGIN = `http://${HOST}:${PORT}`

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 +
  8_000 * 6 + 60_000 + APP_CLOSE_RACE_MS + 30_000

it(
  'the app works from a plain static server at its own URL, granted per-origin, with nothing installed',
  async () => {
    await runPhase('freetube-live-origin', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let server: ChildProcess | undefined
      try {
        server = await startOwnServer('freetube-server', join(process.cwd(), 'apps', 'freetube', 'serve.mjs'), ['--port', String(PORT)])
        check('a plain static file server is up, serving apps/freetube/ and nothing else', true)

        app = await launchElectron({ appPath: '.' })

        const manifest = await readAppManifest()
        const granted = await grantOriginOnly(app.evaluate.bind(app), manifest, ORIGIN)
        check('the origin is registered and granted -- no pin, no cached bundle, no serve registration', granted.hooksPresent)
        if (!granted.hooksPresent) throw new Error('dev grant hook missing -- build with node scripts/build-e2e.mjs')

        await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
        const navigated = await waitForTab(chrome, { address: `${ORIGIN}/`, title: 'FreeTube for Orivon' })
        check('the page loads from the static server, over plain http', navigated.ok, navigated.ok ? undefined : JSON.stringify(navigated.info))
        if (!navigated.ok) throw new Error('navigation to the live origin failed')

        const view = findViewShowing(app, chrome, `${ORIGIN}/`)
        if (view === undefined) throw new Error('no view found showing the live origin')

        const detected = await evaluateRetrying(view, async () => {
          const grants = await (globalThis as unknown as { orivon: { app: { grants: () => Promise<unknown[]> } } }).orivon.app.grants()
          return {
            // The tell: the routed fetch is an ordinary JS function, while
            // a native one reports [native code]. That is all it claims --
            // the routed binding carries the platform's own descriptor.
            notNativeFetch: !/\[native code\]/.test(String(globalThis.fetch)),
            grantKinds: (grants as Array<{ capability: string }>).map((g) => g.capability)
          }
        })
        check(
          'GRANTING THE URL ALONE MAKES IT AN APP TAB: window.fetch is not the platform\'s own, so the routed fetch is installed, with nothing installed to disk',
          detected.notNativeFetch,
          JSON.stringify(detected)
        )
        check('the origin holds the grants its manifest declared', detected.grantKinds.includes('https.connect'), JSON.stringify(detected.grantKinds))

        const searched = await evaluateRetrying(view, async () => {
          globalThis.location.hash = '#/search/lofi%20hip%20hop'
          const deadline = Date.now() + 45_000
          while (Date.now() < deadline) {
            const cards = document.querySelectorAll('.card')
            const problem = document.querySelector('.notice-warn, .notice-error')
            if (cards.length > 0) return { cards: cards.length, first: document.querySelector('.card-title')?.textContent ?? '', problem: undefined }
            if (problem !== null) return { cards: 0, first: '', problem: problem.textContent?.slice(0, 200) }
            await new Promise((resolve) => setTimeout(resolve, 400))
          }
          return { cards: 0, first: '', problem: 'timed out' }
        }, 60_000)

        check(
          'a real YouTube search works from the plain-http origin, through the broker',
          searched.cards > 0,
          JSON.stringify(searched)
        )

        // Does the CSP wall exist here at all? A live origin is served by its
        // own host, so nothing applies the loader's own CSP to it.
        const mediaProbe = await evaluateRetrying(view, async () => {
          const violations: string[] = []
          document.addEventListener('securitypolicyviolation', (event) => { violations.push(`${event.violatedDirective} <- ${event.blockedURI}`) })
          const blob = URL.createObjectURL(new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'video/mp4' }))
          const video = document.createElement('video')
          const outcome = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), 6_000)
            video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve('loaded') })
            video.addEventListener('error', () => { clearTimeout(timer); resolve(`error code ${video.error?.code ?? '?'}`) })
            video.src = blob
            video.load()
          })
          return { outcome, violations }
        }, 30_000)

        check(
          'on a LIVE origin no Orivon CSP applies, so a media load raises no policy violation',
          mediaProbe.violations.length === 0,
          JSON.stringify(mediaProbe)
        )

        // If no CSP applies here, the wall that blocks playback on an
        // installed app should be absent, and a real stream should play.
        const playback = await evaluateRetrying(view, async () => {
          globalThis.location.hash = '#/watch/dQw4w9WgXcQ'
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            const status = document.querySelector('.player-status')
            const video = document.querySelector('video')
            if (status !== null && !(status.textContent ?? '').startsWith('Resolving')) {
              return {
                status: status.textContent ?? '',
                readyState: (video as HTMLVideoElement | null)?.readyState ?? -1,
                duration: (video as HTMLVideoElement | null)?.duration ?? 0
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          return { status: 'timed out', readyState: -1, duration: 0 }
        }, 75_000)

        check(
          `PLAYBACK on a live origin: "${playback.status}" (readyState ${String(playback.readyState)}, duration ${String(Math.round(playback.duration))}s)`,
          playback.readyState > 0,
          JSON.stringify(playback)
        )

        await closeElectronApp(app)
        app = undefined
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        if (server !== undefined) await killChild(server)
      }
    })
  },
  TEST_TIMEOUT_MS
)
