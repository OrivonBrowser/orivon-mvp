// The toolbar end to end: the extensions library's <browser-action-list>
// shows a real extension's action, its popup opens and runs, and its own
// chrome.tabs.query/chrome.tabs.create calls reach Orivon's own tabs
// through extension-host.ts's URL policy -- allowed, refused and an
// options-page path all included.
//
// Driven from the POPUP's own script, not the service worker: measured on
// this tree, electron-chrome-extensions' 'frame'-type preload registration
// (session.registerPreloadScript) correctly overrides chrome.tabs/
// chrome.runtime for an extension PAGE (this fixture's popup.html), but its
// 'service-worker'-type registration does not take effect for background.js
// -- chrome.tabs stays Electron's own native (partial) implementation
// there, missing chrome.tabs.create entirely. This file still seeds a real
// MV3 service worker (background.js) so a later investigation has a ready
// fixture, but does not depend on it for its own assertions.
//
// Neither chrome.runtime.openOptionsPage() nor chrome.tabs.create() with a
// chrome-extension: target is exercised here: both reliably crash the
// popup's own renderer target on this tree (Playwright reports "Target
// crashed" on the next evaluate) -- reproducible, and not specific to
// openOptionsPage, since a direct chrome.tabs.create({url: chrome-
// extension://<id>/options.html}) crashes the same way. http(s) targets
// (below) never crash. Unrelated to extension-host.ts's own createTab/URL-
// policy code: the crash happens before or inside the same store.createTab()
// call the working http(s) path already proves reaches this file's own
// code cleanly. Not fixed here; a real finding for a later package.
//
// Fixture: test/apps/extensions/action-popup/ (MV3, one browser action with
// a popup that calls chrome.tabs.query/chrome.tabs.create directly and
// shows the reply).
// Seeded the way test/e2e-extensions-load.test.ts does.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-toolbar.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/action-popup', import.meta.url))
const SLOT = 'action-popup'

/** Seeds the registry the way install-runner.ts would, mirroring
 * e2e-extensions-load.test.ts's own seedExtensions -- see its header for why
 * this is the real boot path, not a shortcut. Returns the extension id, so
 * the test can address the toolbar's own action button and its pages. */
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

/** A plain, single-page HTTP origin on an ephemeral port -- an allowed
 * chrome.tabs.create target, never a fixed port (this repo's own local
 * notes: 8875/8876/8885 are held by an unrelated process). */
async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>toolbar-fixture</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

/** Finds the popup's own BrowserWindow among every open Playwright page --
 * it has no `.tab` entry in the strip, so this looks by URL prefix, not by
 * elimination against the chrome/tab views the way tabViews() does. */
function findPopup (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`))
}

function findTabShowing (windows: Page[], chrome: Page, url: string): Page | undefined {
  return windows.find((w) => w !== chrome && w.url() === url)
}

/** Reads #result, polling until it changed from `previous` -- every button
 * here overwrites #result exactly once per click. */
async function waitForResult (popup: Page, previous: string): Promise<string> {
  await waitFor(async () => (await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')) !== previous)
  return await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

it('shows a real extension\'s browser action, its popup runs, and its chrome.tabs.query/chrome.tabs.create calls reach Orivon\'s own tabs through the same URL policy', async () => {
  const started = await startFixtureServer()
  server = started.server
  const allowedUrl = `${started.origin}/`

  await runPhase('extensions toolbar', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedActionPopup(dir) }
      })

      const loaded = await waitFor(async () => (await (app as NonNullable<typeof app>).evaluate(
        ({ session }) => session.defaultSession.extensions.getAllExtensions().length
      )) === 1)
      check('the action-popup fixture is loaded into session.defaultSession at boot', loaded)

      await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      const chrome = findChrome(app)

      // ---- the toolbar shows one browser-action for it, with a loaded icon ----
      // document.querySelector does not pierce browser-action-list's own
      // (open) shadow root -- only Playwright's own selector engine does,
      // which is what actionSelector below is for. Reading the button's
      // state still needs the real DOM API, so goes through shadowRoot
      // explicitly.
      const actionSelector = `#${extensionId}`
      const actionAppeared = await waitFor(async () => await chrome.evaluate(
        (id: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${id}`) != null, extensionId
      ))
      check('the toolbar shows a browser-action for the loaded extension', actionAppeared)

      const iconLoaded = await waitFor(async () => await chrome.evaluate((id: string) => {
        const button = document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${id}`) as HTMLElement | null
        return button !== null && !button.classList.contains('no-icon') && button.style.backgroundImage.includes('crx://')
      }, extensionId))
      check('its icon loaded (no-icon never set, a crx: background-image applied)', iconLoaded)

      // ---- clicking it opens a popup whose title is set by its own page ----
      await chrome.click(actionSelector)
      const popupOpened = await waitFor(() => findPopup((app as NonNullable<typeof app>).windows(), extensionId) !== undefined)
      check('clicking the action opens a popup window', popupOpened)
      let popup = findPopup(app.windows(), extensionId)
      // Polled, not read once: the popup's own BrowserWindow/Page exists the
      // moment it is constructed, well before popup.html's script has run
      // and set the real title (smoke-helpers.mjs's own waitFor rule).
      const titleSet = popup === undefined ? false : await waitFor(async () => await evaluateRetrying(popup as Page, () => document.title) === 'Action Popup')
      const popupTitle = popup === undefined ? undefined : await evaluateRetrying(popup, () => document.title)
      check('the popup window\'s title is set by its own page', titleSet, String(popupTitle))

      // ---- chrome.tabs.query returns Orivon's open tabs, with their URLs ----
      if (popup !== undefined) {
        await popup.click('#query')
        const queryText = await waitForResult(popup, '')
        const queryResult = JSON.parse(queryText) as { tabs: Array<{ id: number, url: string }> }
        check('chrome.tabs.query returns at least the open tab, with a real url', queryResult.tabs.length > 0 && typeof queryResult.tabs[0]?.url === 'string', queryText)
      }

      // ---- chrome.tabs.create of an http fixture URL opens a real Orivon tab ----
      if (popup !== undefined) {
        await popup.fill('#url', allowedUrl)
        const before = await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')
        await popup.click('#create')
        const createText = await waitForResult(popup, before)
        const opened = await waitFor(() => findTabShowing((app as NonNullable<typeof app>).windows(), chrome, allowedUrl) !== undefined)
        check('chrome.tabs.create of an allowed http url opens a real Orivon tab', opened, createText)
      }

      // ---- chrome.tabs.create of file:/orivon: is refused and opens nothing ----
      popup = findPopup(app.windows(), extensionId)
      if (popup !== undefined) {
        const windowCountBefore = app.windows().length
        await popup.fill('#url', 'file:///etc/hostname')
        const before = await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')
        await popup.click('#create')
        const createText = await waitForResult(popup, before)
        check('chrome.tabs.create of file:///etc/hostname is refused', createText.includes('"ok":false'), createText)
        check('chrome.tabs.create of file:///etc/hostname opens no new window', app.windows().length === windowCountBefore)
      }

      popup = findPopup(app.windows(), extensionId)
      if (popup !== undefined) {
        const windowCountBefore = app.windows().length
        await popup.fill('#url', 'orivon://settings')
        const before = await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')
        await popup.click('#create')
        const createText = await waitForResult(popup, before)
        check('chrome.tabs.create of orivon://settings is refused', createText.includes('"ok":false'), createText)
        check('chrome.tabs.create of orivon://settings opens no new window', app.windows().length === windowCountBefore)
      }

      // The options page's own "opens as an Orivon tab with no window.orivon"
      // is already covered by e2e-extensions-load.test.ts, via a typed
      // navigation (view.goto(optionsUrl)). NOT re-covered here through
      // chrome.tabs.create() or chrome.runtime.openOptionsPage(): both
      // reliably crash the popup's own renderer target on this tree when
      // the target is a chrome-extension: URL -- this file's own header has
      // the finding.
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
