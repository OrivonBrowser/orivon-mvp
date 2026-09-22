// End-to-end proof for test/apps/freetube/: the app, loaded from a URL, inside a
// REAL app tab, reaching the REAL network through the broker.
//
// WHY THIS EXISTS AND test/apps/freetube/verify.mjs IS NOT ENOUGH. That script
// runs the app's API layer under Node, which shares two properties with a
// routed fetch (no CORS, no forbidden-header list) and nothing else. It
// cannot show that the broker was involved at all. This test navigates a real
// tab to a real registered origin, so every request the page makes travels
// window.fetch -> orivon.net.connectSecure -> the broker's grant check -> TLS
// terminated on the trusted side. If the grant were missing, this test fails.
//
// NO HERMETIC_RESOLVER, DELIBERATELY, AND IT IS THE ONE THING THAT MAKES THIS
// TEST MEAN ANYTHING. Every other e2e file here blackholes DNS. This one
// talks to real YouTube, because the claim under test is "a real app reaches a
// real third-party host under a real grant". The cost is that it depends on
// the public internet and on YouTube's own behaviour, so it is NOT hermetic
// and must not gate CI on its network-dependent checks.
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-freetube-app.test.ts
import { afterAll, expect, it } from 'vitest'


import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { FREETUBE_ORIGIN as ORIGIN, grantAndServe, pinRealApp } from './freetube-fixture.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 +
  8_000 * 8 + 60_000 + APP_CLOSE_RACE_MS + 30_000

it(
  'the FreeTube app, served from its pin at a real origin, reaches YouTube through the broker under a real grant, and its player reports exactly which wall stops playback',
  async () => {
    await runPhase('freetube-app', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      try {
        // Real DNS on purpose -- see this file's header.
        app = await launchElectron({ appPath: '.' })

        const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
        const { manifest, fileCount } = await pinRealApp(userDataDir)
        check(`the real app bundle pins (${fileCount} files from test/apps/freetube/)`, fileCount > 10)

        const wired = await grantAndServe(app.evaluate.bind(app), manifest)

        check('the dev-only grant and serve hooks are installed (built via scripts/build-e2e.mjs)', wired.hooksPresent)
        if (!wired.hooksPresent) throw new Error('dev hooks missing -- build with node scripts/build-e2e.mjs')

        const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        check('the shell reaches its launch-time window count', windowsReady)

        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
        const navigated = await waitForTab(chrome, { address: `${ORIGIN}/`, title: 'FreeTube for Orivon' })
        check('the app loads from its URL, served from its pin', navigated.ok, navigated.ok ? undefined : JSON.stringify(navigated.info))
        if (!navigated.ok) throw new Error('the app tab failed to navigate')

        const view = findViewShowing(app, chrome, `${ORIGIN}/`)
        if (view === undefined) throw new Error('no view found showing the app origin')

        // ---- What the app itself concluded about its tab -----------------
        const detected = await evaluateRetrying(view, async () => {
          const grants = await (globalThis as unknown as { orivon: { app: { grants: () => Promise<unknown[]> } } }).orivon.app.grants()
          return {
            hasOrivon: typeof (globalThis as { orivon?: unknown }).orivon === 'object',
            // The tell: the routed fetch is an ordinary JS function, while
            // a native one reports [native code]. That is all it claims --
            // the routed binding carries the platform's own descriptor.
            notNativeFetch: !/\[native code\]/.test(String(globalThis.fetch)),
            grantKinds: (grants as Array<{ capability: string }>).map((g) => g.capability),
            csp: document.querySelector('meta[http-equiv]')?.getAttribute('content') ?? '(header only)'
          }
        })
        check('this is a REGISTERED APP TAB: window.fetch is not the platform\'s own function, so the routed fetch is installed', detected.notNativeFetch, JSON.stringify(detected))
        check('the app holds the two grants it declared', detected.grantKinds.includes('https.connect') && detected.grantKinds.includes('fs'), JSON.stringify(detected.grantKinds))

        // ---- The broker's own TLS dial, apart from the app's use of it ---
        // The regression guard for SNI. `tls.connect({ host, port })` sends no
        // server name in that object form, and a name-based virtual host then
        // answers with a certificate for nobody; verification refuses it. No
        // local test server can catch this -- one certificate is served
        // whether SNI arrives or not -- so it needs a real multi-tenant host.
        const dialProbe = await evaluateRetrying(view, async () => {
          const orivon = (globalThis as unknown as {
            orivon: { net: { connectSecure: (o: { host: string, port: number }) => Promise<{ close: () => Promise<void> }>, lookup: (o: { hostname: string }) => Promise<unknown> } }
          }).orivon
          const describe = (error: unknown): string => {
            const err = error as { code?: string, platformCode?: string, message?: string }
            return JSON.stringify({ code: err.code, platformCode: err.platformCode, message: err.message })
          }
          let lookup: string
          try {
            lookup = JSON.stringify(await orivon.net.lookup({ hostname: 'www.youtube.com' }))
          } catch (error) {
            lookup = `threw ${describe(error)}`
          }
          let dial: string
          try {
            const socket = await orivon.net.connectSecure({ host: 'www.youtube.com', port: 443 })
            await socket.close()
            dial = 'connected'
          } catch (error) {
            dial = `threw ${describe(error)}`
          }
          return { lookup, dial }
        }, 30_000)

        check(
          `the broker's TLS dial completes against a real name-based virtual host (net.lookup, a separate open finding: ${dialProbe.lookup})`,
          dialProbe.dial === 'connected',
          dialProbe.dial
        )

        // ---- The claim the whole port rests on ---------------------------
        const searched = await evaluateRetrying(view, async () => {
          globalThis.location.hash = '#/search/lofi%20hip%20hop'
          const deadline = Date.now() + 45_000
          while (Date.now() < deadline) {
            const cards = document.querySelectorAll('.card')
            const warn = document.querySelector('.notice-warn, .notice-error')
            if (cards.length > 0) {
              return { cards: cards.length, first: document.querySelector('.card-title')?.textContent ?? '', problem: undefined }
            }
            if (warn !== null) return { cards: 0, first: '', problem: warn.textContent?.slice(0, 200) }
            await new Promise((resolve) => setTimeout(resolve, 400))
          }
          return { cards: 0, first: '', problem: 'timed out' }
        }, 60_000)

        check(
          'a REAL search reaches YouTube through the broker and renders real results -- ' +
          'this request set Origin and User-Agent, which a browser forbids a page to set, ' +
          'to an origin CORS would refuse outright',
          searched.cards > 0,
          JSON.stringify(searched)
        )

        // ---- An installed app's served CSP, measured rather than read -----
        // MSE playback hands the <video> a blob: URL, so media-src must admit
        // blob:. A remote CDN host stays refused unless it is granted.
        const mediaProbe = await evaluateRetrying(view, async () => {
          const violations: string[] = []
          document.addEventListener('securitypolicyviolation', (event) => {
            violations.push(`${event.violatedDirective} <- ${event.blockedURI}`)
          })
          const tryLoad = async (src: string): Promise<string> => {
            const video = document.createElement('video')
            return await new Promise((resolve) => {
              const timer = setTimeout(() => resolve('timeout'), 6_000)
              video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve('loaded') })
              video.addEventListener('error', () => { clearTimeout(timer); resolve(`error code ${video.error?.code ?? '?'}`) })
              video.src = src
              video.load()
            })
          }
          const blob = URL.createObjectURL(new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'video/mp4' }))
          const blobOutcome = await tryLoad(blob)
          const remoteOutcome = await tryLoad('https://rr1---sn-4g5ednsk.googlevideo.com/videoplayback?probe=1')
          return { blobOutcome, remoteOutcome, violations }
        }, 30_000)

        const blobBlockedByCsp = (mediaProbe.violations as string[]).some((entry: string) => entry.includes('media-src') && entry.includes('blob'))
        check(
          "on an INSTALLED app, the served CSP's media-src admits a blob: URL (MSE playback)",
          !blobBlockedByCsp,
          JSON.stringify(mediaProbe)
        )

        await closeElectronApp(app)
        app = undefined
      } finally {
        if (app !== undefined) await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
