// Upstream FreeTube's own web build, unmodified, running as an Orivon app.
//
// Nothing here is a port: `apps/freetube-real/prepare.mjs` adds a manifest and
// a discovery hint to a stock `pnpm run pack:web` output and changes nothing
// else. What this measures is how much of a real, third-party application
// works when the only thing done for it is granting its URL the network.
//
// TWO BUILDS EXIST AND THEY ANSWER DIFFERENT QUESTIONS.
//   - `dist/orivon-web` is upstream's web build verbatim. Upstream compiles
//     it with `SUPPORTS_LOCAL_API: false` and stubs `youtubei.js` out, so its
//     ONLY backend is Invidious.
//   - `dist/orivon-web-localapi` is the same build with those two settings
//     flipped (`_scripts/webpack.web-localapi.config.js` in the clone, which
//     patches upstream's own config rather than forking it). Upstream turns
//     the Local API off for the web because a browser cannot reach YouTube
//     directly. Inside Orivon it can, so this build asks what that buys.
//
// Requires a prepared build and an ORDINARY shell build; skipped otherwise,
// for the same reason e2e-dev-origin-grant.test.ts is.
//
// NO RESTART-PERSISTENCE CHECK: proving a settings change survives an app
// restart needs a second launchElectron() call against the SAME
// --user-data-dir as the first. launch-electron.mjs has no such capability
// today -- userDataDir is generated fresh with mkdtemp() inside
// launchElectron() itself, never exposed to a caller, and unconditionally
// removed by closeElectron()'s own finally block. Adding that is a change
// to test/, owned by the shell stream, not this one -- checked, not
// guessed, before leaving it out.
//
// RUN THIS WITH:
//   node scripts/build-ordinary.mjs
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
const ROOT = process.env['ORIVON_FREETUBE_REAL_ROOT'] ?? '/home/jhon/git/freetube-src/dist/orivon-web-localapi'
const BUILT = existsSync(join(ROOT, 'index.html'))

/**
 * Playback needs a minted PoToken (ftElectron.generatePoToken, ADR-0019's
 * web.context). ON BY DEFAULT once the prepared build's own manifest
 * declares `web` -- that is the build that can actually mint one -- so a
 * build without it (`dist/orivon-web`, `dist/orivon-web-localapi`) still
 * only gets the metadata checks above, exactly as before. `=0` forces it
 * off even against a `web`-declaring build; `=1` forces it on regardless
 * (a manifest edit not yet re-prepared, say). See README.md's "Playback on
 * the Electron-renderer build" for what this build now measures.
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

/**
 * Unlike REQUIRE_PLAYBACK, deliberately NOT overridable by an env var: the
 * checks this gates (below) read real files through `window.orivon.fs`, so
 * running them against a build whose manifest does not actually declare
 * `web` -- meaning `prepare.mjs --build` never wired the Electron datastore
 * bundle in at all -- would just fail on a missing global, not prove
 * anything about storage. `dist/orivon-electron` is the one build where
 * this is true (apps/freetube-real/README.md's "Storage").
 */
const USES_ELECTRON_DATASTORE = manifestDeclaresWeb()

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
  (REQUIRE_PLAYBACK ? 40_000 : 0) + (USES_ELECTRON_DATASTORE ? 25_000 : 0)

/** The six nedb datafiles `src/datastores/index.js` names when `IS_ELECTRON_MAIN` is falsy -- see apps/freetube-real/README.md's "Where the data lands". Bare relative filenames: they land directly at the app's own fs root, not inside a subdirectory. */
const NEDB_FILES = ['settings.db', 'profiles.db', 'playlists.db', 'history.db', 'search-history.db', 'subscription-cache.db'] as const

interface OrivonPageGlobal {
  orivon: {
    fs: {
      readFile: (path: string) => Promise<Uint8Array>
      stat: (path: string) => Promise<{ size: number }>
    }
  }
}

it.skipIf(!ORDINARY_BUILD || !BUILT)(
  'upstream FreeTube, unmodified, boots as an Orivon app from a plain static server',
  async () => {
    await runPhase('freetube-real', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let server: ChildProcess | undefined
      try {
        server = await startOwnServer('freetube-real-server', join(process.cwd(), 'apps', 'freetube-real', 'serve.mjs'), ['--root', ROOT, '--port', String(PORT)])
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
              // The tell: the routed fetch is an ordinary JS function, while
              // a native one reports [native code]. That is all it claims --
              // the routed binding carries the platform's own descriptor.
              const notNative = !/\[native code\]/.test(String(globalThis.fetch))
              const mount = document.querySelector('#app')
              return notNative && mount !== null && mount.children.length > 0
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

        if (USES_ELECTRON_DATASTORE && populated) {
          // (a) All six nedb files exist at the app's own fs root.
          //
          // NOT orivon.fs.readdir at the root: confinePath (src/broker/policy/
          // paths.ts) denies EVERY root-resolving path -- '.', '', 'a/..', a
          // trailing-slash-only root -- with reason 'is-root', unconditionally,
          // for every fs.* method, not only readdir (src/broker/policy/tests/
          // paths.test.ts's 'rejects degenerate input' table;
          // src/broker/tests/index-fs-extended.test.ts carries the identical
          // rule with its own "Not readdir('.')" comment). There is no string
          // that names the root to readdir; `DirectoryHandle`'s own root-omission
          // convenience (handles.ts) is a different type, reachable only through
          // a user-picked OS folder, never the app's own confined fs. `stat` per
          // known filename is the one call shape that both proves a root-level
          // file exists and reports its size, which is what this checks instead.
          const rootView = viewAtOrigin(app, chrome, ORIGIN)
          const statResults: Record<string, { ok: boolean, size?: number, error?: string }> = rootView === undefined
            ? {}
            : await rootView.evaluate(async (files: readonly string[]) => {
              const orivon = (globalThis as unknown as OrivonPageGlobal).orivon
              const out: Record<string, { ok: boolean, size?: number, error?: string }> = {}
              for (const file of files) {
                try {
                  const stat = await orivon.fs.stat(file)
                  out[file] = { ok: true, size: stat.size }
                } catch (error) {
                  out[file] = { ok: false, error: error instanceof Error ? error.message : String(error) }
                }
              }
              return out
            }, NEDB_FILES)
          const allFilesPresent = NEDB_FILES.every((file) => statResults[file]?.ok === true)
          check(
            'all six nedb datastore files exist at the app fs root (orivon.fs.stat per file)',
            allFilesPresent,
            JSON.stringify(statResults)
          )

          // (b) history.db actually contains the watched video's id.
          //
          // Bounded poll, not a fixed sleep: FreeTube writes the history
          // record from Watch.js's handleVideoLoaded() -> addToHistory(), which
          // fires once the player component signals it has loaded (guarded by
          // the rememberHistory setting, true by default) -- read directly from
          // the clone's source, not assumed. That should already have happened
          // by the time the playback check above passed, but this polls for the
          // real bytes on disk instead of inferring it from a timing
          // coincidence.
          const readHistoryText = async (): Promise<string | undefined> => {
            const view = viewAtOrigin(app as NonNullable<typeof app>, chrome, ORIGIN)
            if (view === undefined) return undefined
            try {
              return await view.evaluate(async () => {
                const orivon = (globalThis as unknown as OrivonPageGlobal).orivon
                const bytes = await orivon.fs.readFile('history.db')
                return new TextDecoder().decode(bytes)
              })
            } catch {
              return undefined
            }
          }
          const historyWritten = await waitFor(async () => {
            const text = await readHistoryText()
            return text !== undefined && text.includes('dQw4w9WgXcQ')
          }, 20_000)
          const historyExcerpt = (await readHistoryText())?.slice(0, 400)
          check(
            "history.db's NDJSON contains the watched video's id (dQw4w9WgXcQ)",
            historyWritten,
            JSON.stringify({ historyExcerpt })
          )

          // (c) Nothing landed in IndexedDB. localForage's own default
          // database name is 'localforage' -- exactly what handlers/web.js's
          // browser nedb build would have used, had the DB_HANDLERS alias
          // still pointed there.
          const idbView = viewAtOrigin(app, chrome, ORIGIN)
          const idbDatabaseNames: string[] | null = idbView === undefined
            ? null
            : await idbView.evaluate(async () => {
              if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null
              const databases = await indexedDB.databases()
              return databases.map((database) => database.name ?? '')
            })
          check(
            "no localForage/nedb-browser IndexedDB database exists (indexedDB.databases() names none 'localforage')",
            idbDatabaseNames !== null && !idbDatabaseNames.includes('localforage'),
            JSON.stringify({ idbDatabaseNames })
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
