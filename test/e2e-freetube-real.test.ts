// Upstream FreeTube, unmodified, running as an Orivon app.
//
// Nothing here is a fork: the `orivon-ports` repository clones FreeTube at a
// pinned commit, builds it with its own toolchain, and adds a manifest, a
// discovery hint and a bridge script. What this measures is how much of a
// real, third-party application works when the only thing done for it is
// granting its URL the network and standing in for the Electron main process.
//
// THE APP LIVES IN THE SIBLING REPOSITORY, not here. This file drives it
// because the shell is what has to load it, and the shell is here.
//
// Requires a prepared build in that checkout and an ORDINARY shell build;
// skipped otherwise, for the same reason e2e-dev-origin-grant.test.ts is.
//
// RUN THIS WITH:
//   cd ../orivon-ports && node src/cli.ts build freetube
//   cd -  &&  node scripts/build-ordinary.mjs
//   ORIVON_ORDINARY_BUILD=1 npx vitest run --config test/vitest.e2e.config.ts test/e2e-freetube-real.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, tabViews, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, killChild, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { PORT_APP_FREETUBE_REAL, startOwnServer } from './freetube-fixture.js'

const ORDINARY_BUILD = process.env['ORIVON_ORDINARY_BUILD'] === '1'

/**
 * The sibling checkout of `orivon-ports`, which owns the app. A path rather
 * than a dependency: this repository must build, test and ship without that
 * one present, so an absent sibling skips this file rather than failing it.
 */
const PORTS_ROOT = process.env['ORIVON_PORTS_ROOT'] ?? join(process.cwd(), '..', 'orivon-ports')
const ROOT = process.env['ORIVON_FREETUBE_REAL_ROOT'] ?? join(PORTS_ROOT, 'out', 'freetube', 'static')
const BUILT = existsSync(join(ROOT, 'index.html'))

/**
 * Playback needs a minted PoToken (ftElectron.generatePoToken, ADR-0019's
 * web.context). ON BY DEFAULT once the prepared build's own manifest
 * declares `web` -- that is the build that can actually mint one -- so a
 * build without it still only gets the metadata checks above. `=0` forces
 * it off even against a `web`-declaring build; `=1` forces it on regardless
 * (a manifest edit not yet re-prepared, say).
 */
function manifestDeclaresWeb (): boolean {
  if (!BUILT) return false
  try {
    const manifest: { capabilities?: { web?: unknown } } = JSON.parse(readFileSync(join(ROOT, '.well-known', 'orivon.json'), 'utf8'))
    return manifest.capabilities?.web !== undefined
  } catch {
    return false
  }
}
const REQUIRE_PLAYBACK = process.env['ORIVON_FREETUBE_REAL_PLAYBACK'] === '0'
  ? false
  : process.env['ORIVON_FREETUBE_REAL_PLAYBACK'] === '1' || manifestDeclaresWeb()

const HOST = '127.0.0.1'
const PORT = Number(process.env['ORIVON_FREETUBE_REAL_PORT'] ?? PORT_APP_FREETUBE_REAL)
const ORIGIN = `http://${HOST}:${PORT}`

afterAll(async () => {
  if (!ORDINARY_BUILD || !BUILT) return
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** FreeTube's own router rewrites the URL the moment it mounts, so the exact-URL `findViewShowing` stops matching. Match the origin instead: the tab is still the same tab. */
type TabView = ReturnType<typeof tabViews>[number]

function viewAtOrigin (app: Parameters<typeof tabViews>[0], chrome: Parameters<typeof tabViews>[1], origin: string): TabView | undefined {
  return (tabViews(app, chrome) as TabView[]).find((view: TabView) => view.url().startsWith(origin))
}

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + 8_000 * 8 + 120_000 + APP_CLOSE_RACE_MS + 60_000 +
  (REQUIRE_PLAYBACK ? 40_000 : 0)

it.skipIf(!ORDINARY_BUILD || !BUILT)(
  'upstream FreeTube, unmodified, boots as an Orivon app from a plain static server',
  async () => {
    await runPhase('freetube-real', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let server: ChildProcess | undefined
      try {
        // The sibling's own executor, not a server of ours: what it serves
        // is what a person running `orivon-port serve freetube` gets.
        server = await startOwnServer('freetube-real-server', join(PORTS_ROOT, 'src', 'cli.ts'), ['serve', 'freetube', '--port', String(PORT)])
        check(`a plain static server is serving the prepared upstream build (${ROOT})`, true)

        // The opt-in `npm run dev` sets, so the loopback origin is granted
        // without being installed rather than refused by the install path.
        app = await launchElectron({ appPath: '.', env: { ORIVON_DEV_ORIGINS: '1' } })
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
        })

        await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
        const chrome = findChrome(app)
        await waitForAddressBarStable(chrome)
        await clickAddressBarRetrying(chrome, `${ORIGIN}/`)

        const state = await waitFor(async () => {
          const view = viewAtOrigin(app as NonNullable<typeof app>, chrome, ORIGIN)
          if (view === undefined) return false
          try {
            return await view.evaluate(() => {
              const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
              const routed = descriptor !== undefined && descriptor.writable === false && descriptor.configurable === false
              const mount = document.querySelector('#app')
              return routed && mount !== null && mount.children.length > 0
            })
          } catch { return false }
        }, 40_000)
        check('FreeTube mounts its Vue app inside a granted Orivon app tab', state)

        const view = viewAtOrigin(app, chrome, ORIGIN)
        if (view === undefined) throw new Error('no view showing the origin')

        const report = await view.evaluate(() => {
          const errors = (globalThis as unknown as { __ftErrors?: string[] }).__ftErrors ?? []
          return {
            title: document.title,
            appChildren: document.querySelector('#app')?.children.length ?? 0,
            hasTopNav: document.querySelector('.topNav, #topNav, header') !== null,
            hasSideNav: document.querySelector('.sideNav, #sideNav, nav') !== null,
            bodyTextSample: (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
            errors: errors.slice(0, 5)
          }
        })
        check(`what upstream FreeTube rendered: ${JSON.stringify(report)}`, report.appChildren > 0)

        // Opening a video: does FreeTube's own Local API reach YouTube through
        // the routed fetch and populate the watch page?
        //
        // Navigated from INSIDE the page, not through the address bar: this is
        // a same-origin route in an app tab that already holds its grants, so
        // it needs no repartition -- and driving the omnibox for it only adds
        // a view swap to race against.
        const consoleErrors: string[] = []
        view.on('console', (message: { type: () => string, text: () => string }) => {
          if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200))
        })
        // The STACK, not just the message: an uncaught TypeError's message
        // names no code, and this build is unminified precisely so the frames
        // are readable.
        view.on('pageerror', (error: Error) => {
          consoleErrors.push(`pageerror: ${error.message} :: ${(error.stack ?? '(no stack)').slice(0, 900)}`)
        })

        // FreeTube's router is createWebHashHistory() and its route is
        // `/watch/:id`, so the video URL is a HASH route. A path like
        // `/watch?id=...` is not a route at all: the static server's SPA
        // fallback answers it with index.html, the router then resets to `#/`,
        // and every relative asset request 404s from the wrong base.
        await view.evaluate(() => { globalThis.location.hash = '#/watch/dQw4w9WgXcQ' })

        // FreeTube sets `document.title` to the video's own title once the
        // Local API has answered, so the title is the signal. Non-empty is
        // load-bearing: an empty title also "does not start with
        // Subscriptions", so omitting it lets a page that never rendered pass.
        const readTitle = async (): Promise<string> => {
          const current = viewAtOrigin(app as NonNullable<typeof app>, chrome, ORIGIN)
          if (current === undefined) return ''
          try { return await current.evaluate(() => document.title) } catch { return '' }
        }
        const populated = await waitFor(async () => {
          const title = await readTitle()
          return title.length > 0 && !title.startsWith('Subscriptions')
        }, 45_000)

        const current = viewAtOrigin(app, chrome, ORIGIN)
        const watch = current === undefined
          ? { missing: true }
          : await current.evaluate(() => ({
            url: globalThis.location.href,
            title: document.title,
            text: (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
          }))
        check(
          'FreeTube populated the watch page with real video details',
          populated,
          populated ? undefined : JSON.stringify({ watch, consoleErrors: consoleErrors.slice(0, 6) })
        )

        if (REQUIRE_PLAYBACK) {
          // readyState/a mounted <video> is not enough: a manifest with no
          // media fetched satisfies that too. currentTime advancing across
          // two samples is the one signal that bytes are actually flowing.
          const currentTime = async (): Promise<number> => {
            const view = viewAtOrigin(app as NonNullable<typeof app>, chrome, ORIGIN)
            if (view === undefined) return -1
            try { return await view.evaluate(() => document.querySelector('video')?.currentTime ?? -1) } catch { return -1 }
          }
          const pastThreeSeconds = populated && await waitFor(async () => (await currentTime()) > 3, 30_000)
          let stillAdvancing = false
          let first = -1
          let second = -1
          if (pastThreeSeconds) {
            first = await currentTime()
            await new Promise((resolve) => setTimeout(resolve, 2_000))
            second = await currentTime()
            stillAdvancing = second > first
          }
          check(
            'playback: <video>.currentTime exceeds 3s and is still advancing 2s later',
            pastThreeSeconds && stillAdvancing,
            pastThreeSeconds && stillAdvancing ? undefined : JSON.stringify({ populated, first, second })
          )
        }
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        if (server !== undefined) await killChild(server)
      }
    })
  },
  TEST_TIMEOUT_MS
)
