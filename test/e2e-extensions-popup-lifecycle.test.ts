// Chrome closes an extension's browserAction popup on: focus moving
// elsewhere in the browser (the page, the toolbar), a tab switch, the
// active tab navigating, and Escape pressed inside the popup -- but keeps
// it open if focus leaves the app entirely (a login-form popup's own
// convenience, popup.ts's own maybeClose doc). `window.close()` from
// inside the popup always works. Moving/resizing/minimising the window
// closes it too, covered in src/main/extensions/tests/popup-lifecycle.test.ts
// instead (see that file's own header for why, not measurable here).
//
// The page/toolbar-focus checks drive focus through `focusWebContents`
// (test/focus-helpers.ts), not a real Playwright click: measured directly,
// asking Electron for REAL (non-showInactive) focus under bare xvfb-run --
// with or without a window manager on the display (with-window-manager.mjs
// starts one) -- makes the very first click that opens the
// popup fail to register at all. `focusWebContents` exercises the
// identical native blur/focus event pair a real click produces, and is the
// pattern this repo's own focus-helpers.ts documents as the sanctioned way
// to test a focus transition under the virtual display.
//
// Run with:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs \
//     npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-popup-lifecycle.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { ABSENCE_SETTLE_MS, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import { focusWebContents } from './focus-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/action-popup', import.meta.url))
const SLOT = 'action-popup'

// Never lets Chromium reach a real audio device: xvfb hides the window,
// not the sound, and this launches under the owner's own PulseAudio/ALSA
// session. No fixture here plays audio, but every Electron launch in this
// repo is moving to these defaults regardless (test/launch-electron.mjs).
const NO_AUDIO_ENV = { PULSE_SERVER: 'unix:/nonexistent' }
const NO_AUDIO_ARGS = ['--alsa-output-device=null']

function seedActionPopup (userDataDir: string): string {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`action-popup fixture's manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, SLOT)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', SLOT, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const id = generateId(key)
  const now = Date.now()
  const entry: InstalledExtension = {
    id,
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: FIXTURE_DIR },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
  return id
}

async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>popup-lifecycle-frame</title><body>frame</body>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    // A same-origin iframe -- reloading it fires 'did-start-navigation'
    // with isMainFrame: false, the subframe case popup.ts's close-on-
    // navigation must not react to.
    res.end('<!doctype html><title>popup-lifecycle-fixture</title><body>fixture page<iframe id="f" src="/frame"></iframe></body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

function findPopup (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`))
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

it('closes an open browserAction popup the way Chrome does, and keeps window.close() working', async () => {
  const started = await startFixtureServer()
  server = started.server
  const fixtureUrl = `${started.origin}/`

  await runPhase('popup lifecycle', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {},
        seedProfile: async (dir) => { extensionId = seedActionPopup(dir) },
        sandbox: true
      })
      const liveApp = app

      await waitFor(async () => (await liveApp.evaluate(
        ({ session }) => session.defaultSession.extensions.getAllExtensions().length
      )) === 1)
      await waitFor(() => liveApp.windows().length === 2)
      const chrome = findChrome(liveApp)
      const chromeUrl = chrome.url()

      const actionSelector = `#${extensionId}`
      await waitFor(async () => await chrome.evaluate(
        (id: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${id}`) != null, extensionId
      ))

      /** A popup a previous scenario's own close check timed out on (never
       * confirmed closed) would otherwise eat the NEXT scenario's own
       * opening click -- browser-action.ts's activateClick toggles an
       * still-open popup closed instead of opening a fresh one. Each
       * scenario's own check() below still fails/passes on its own merits;
       * this only keeps one scenario's failure from cascading into the
       * next one's. */
      async function closeLeftoverPopup (): Promise<void> {
        const leftover = findPopup(liveApp.windows(), extensionId)
        if (leftover === undefined) return
        await leftover.evaluate(() => { window.close() }).catch(() => {})
        await waitFor(() => findPopup(liveApp.windows(), extensionId) === undefined)
      }

      /** Opens the popup fresh and waits for its own BrowserWindow to be
       * visible -- popup.ts's visibility fallback (500ms) covers the case
       * 'preferred-size-changed' never arrives, so this never hangs even
       * without a real compositor. */
      async function openPopup (): Promise<Page> {
        await closeLeftoverPopup()
        await chrome.click(actionSelector)
        await waitFor(() => findPopup(liveApp.windows(), extensionId) !== undefined)
        const popup = findPopup(liveApp.windows(), extensionId)
        if (popup === undefined) throw new Error('popup did not open')
        await waitFor(async () => await liveApp.evaluate(({ BrowserWindow }, id: string) => {
          const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(`chrome-extension://${id}/`))
          return win !== undefined && win.isVisible()
        }, extensionId), 2000)
        return popup
      }

      const popupClosed = async (): Promise<boolean> => await waitFor(() => findPopup(liveApp.windows(), extensionId) === undefined)

      // ---- window.close() from inside the popup ----
      const p1 = await openPopup()
      await p1.evaluate(() => { window.close() })
      check('window.close() from inside the popup closes it', await popupClosed())

      // ---- focus moving to the page closes it ----
      // Excludes the main menu's own warm, kept-alive-while-hidden overlay
      // (test/e2e-menu-warm.test.ts) in addition to the chrome view and the popup itself -- it lingers in
      // app.windows() long after it last showed, and is not the page a
      // person's click would actually focus.
      await openPopup()
      const view = liveApp.windows().find((w) =>
        w !== chrome && !w.url().includes('/overlay/') && findPopup(liveApp.windows(), extensionId) !== w)
      if (view !== undefined) await focusWebContents(liveApp, view.url())
      check('focus moving to the page closes the popup', await popupClosed())

      // ---- focus moving to the toolbar closes it ----
      await openPopup()
      await focusWebContents(liveApp, chromeUrl)
      check('focus moving to the toolbar closes the popup', await popupClosed())

      // ---- Escape inside the popup closes it ----
      // Sent through webContents.sendInputEvent (test/e2e-shell-fidelity.test.ts's
      // own pattern), not Playwright's page.keyboard: measured directly, a
      // CDP-level key press is silently dropped by Chromium's own input
      // routing when the target window never took real OS focus -- the
      // same headless/no-compositor gap popup.ts's own visibility fallback
      // exists for for showing the popup, but has no equivalent for. Real
      // input dispatched through Electron's own webContents API reaches
      // 'before-input-event' regardless.
      const p2 = await openPopup()
      const p2Url = p2.url()
      await liveApp.evaluate(({ webContents }, url: string) => {
        const wc = webContents.getAllWebContents().find((c) => c.getURL() === url)
        wc?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        wc?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      }, p2Url)
      check('Escape inside the popup closes it', await popupClosed())

      // ---- switching tabs closes it ----
      await openPopup()
      await chrome.click('#new-tab')
      check('switching tabs closes the popup', await popupClosed())

      // ---- the active tab navigating closes it ----
      await openPopup()
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, fixtureUrl)
      check('the active tab navigating closes the popup', await popupClosed())

      // ---- a same-document navigation or a subframe's own navigation does
      // NOT close it -- any web page holding an ad iframe, or merely
      // calling history.pushState, must not be able to close a person's
      // still-open password-manager popup out from under them. An absence
      // is settled once, never polled for (testing.md's own rule 3: a
      // waitFor pointed at a condition already true reports a green no-op).
      await openPopup()
      const fixtureTab = liveApp.windows().find((w) => w.url() === fixtureUrl)
      if (fixtureTab !== undefined) {
        await fixtureTab.evaluate(() => {
          history.pushState({}, '', '#pushed')
          const frame = document.getElementById('f') as HTMLIFrameElement | null
          frame?.contentWindow?.location.reload()
        })
      }
      await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
      check(
        'a same-document navigation or a subframe reload does not close the popup',
        findPopup(liveApp.windows(), extensionId) !== undefined
      )

      // Moving/resizing/minimising the shell window also closes the popup
      // (popup.ts's own parent 'move'/'resize'/'minimize' handlers) --
      // measured directly, a synthetic setPosition()/setSize()/minimize()
      // on a BaseWindow does not reliably produce the corresponding native
      // event at all under this virtual display, with or without a window
      // manager present (test/with-window-manager.mjs), so it cannot be
      // pinned to an e2e assertion here. Covered instead by
      // src/main/extensions/tests/popup-lifecycle.test.ts, which drives
      // those same handlers directly against a fake parent window.
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
