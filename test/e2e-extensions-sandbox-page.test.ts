// A manifest sandbox.pages document gets no chrome.* API at all in real
// Chrome, AND runs at an opaque ("null") origin -- extensions put
// untrusted code (templates, eval) there precisely because it cannot reach
// extension APIs or the rest of the extension's own world. Proves
// UPSTREAM.md patches 37 and 40 end to end, against the real shell: the
// fixture (test/apps/extensions/sandbox-page/) opens its own sandbox.html
// as a tab, AND a framer.html that puts the SAME sandbox page inside an
// iframe, from its own service worker on load (a sandboxed page has no
// chrome.* to drive an interaction from itself, so the extension's own
// initiative is the trigger, the same pattern
// test/apps/extensions/action-popup's own sibling probes use). The framed
// copy is read through Playwright's own per-frame evaluate (CDP), not the
// framer page's own script -- same-origin policy blocks the framer's OWN
// JS from reading a genuinely opaque-origin iframe's DOM, which is exactly
// what patch 40 is for. A forged crx-msg claiming to be this same
// sandboxed frame is refused by the router itself --
// src/main/extensions/tests/router-sandbox-page-refusal.test.ts covers
// that directly, deterministically, since a real sandboxed page has no way
// to reach ipcRenderer at all once this fixture's own popup-less, chrome-
// less page proves the preload correctly refused to expose anything.
//
// Run with:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-sandbox-page.test.ts
import { afterAll, expect, it } from 'vitest'
import { readFileSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Frame, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/sandbox-page', import.meta.url))
const SLOT = 'sandbox-page'

function seedSandboxPage (userDataDir: string): string {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`sandbox-page fixture's manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, SLOT)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', SLOT, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const id = generateId(key)
  // UPSTREAM.md patch 41: framer.html's own variant iframes need the real
  // generated id, not known until here -- substituted into the SEEDED
  // copy only, so the tracked fixture keeps the literal placeholder.
  // Static at initial parse, like the canonical #f iframe, rather than set
  // by a script afterward: measured to matter (a script-driven src
  // assignment's own frame.url is not yet visible to the main process at
  // the exact moment the vendored preload's synchronous sandbox-page query
  // runs, so it always answered false, regardless of isSandboxPageUrl's
  // own correctness -- a document present in the page's own initial HTML
  // does not have this race).
  const framerPath = join(targetDir, 'framer.html')
  writeFileSync(framerPath, readFileSync(framerPath, 'utf8').replaceAll('__EXTENSION_ID__', id))
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

function findSandboxTab (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url() === `chrome-extension://${extensionId}/sandbox.html`)
}

function findFramerTab (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url() === `chrome-extension://${extensionId}/framer.html`)
}

function findFrameByName (page: Page, name: string): Frame | undefined {
  return page.frames().find((f) => f.name() === name)
}

/** The same report sandbox.js's own dataset carries, read back through a
 * frame (not the framer page's own script, which same-origin policy blocks
 * once the frame is genuinely opaque-origin -- Playwright's own per-frame
 * CDP evaluate reaches it regardless, the same pattern the framed-sandbox
 * assertions above already use) -- undefined for an iframe whose src never
 * actually loaded the real sandbox.html (a 404/network-error page runs no
 * extension script at all, UPSTREAM.md patch 41's own e2e measurement). */
async function frameSandboxReport (frame: Frame): Promise<Record<string, string | undefined> | undefined> {
  const settled = await waitFor(async () => await frame.evaluate(() =>
    document.documentElement.dataset.hasChrome !== undefined
  ), 5_000)
  if (!settled) return undefined
  return await frame.evaluate(() => ({
    hasChrome: document.documentElement.dataset.hasChrome,
    hasTabs: document.documentElement.dataset.hasTabs,
    windowOrigin: document.documentElement.dataset.windowOrigin,
    href: document.documentElement.dataset.href
  }))
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

it('gives a manifest sandbox.pages document no chrome.tabs, the way real Chrome does', async () => {
  await runPhase('extensions sandbox page', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedSandboxPage(dir) },
        sandbox: true
      })

      const loaded = await waitFor(async () => (await (app as NonNullable<typeof app>).evaluate(
        ({ session }) => session.defaultSession.extensions.getAllExtensions().length
      )) === 1)
      check('the sandbox-page fixture is loaded into session.defaultSession at boot', loaded)

      const opened = await waitFor(() => findSandboxTab((app as NonNullable<typeof app>).windows(), extensionId) !== undefined, 15_000)
      check('the fixture opens its own sandbox.html as a tab from its service worker', opened)

      const sandboxTab = findSandboxTab(app.windows(), extensionId)
      if (sandboxTab !== undefined) {
        const settled = await waitFor(async () => await evaluateRetrying(sandboxTab, () =>
          document.documentElement.dataset.tabsQueryOutcome !== undefined
        ))
        check('the sandboxed page settles its own chrome.tabs.query attempt', settled)

        const report = await evaluateRetrying(sandboxTab, () => ({
          hasChrome: document.documentElement.dataset.hasChrome,
          hasTabs: document.documentElement.dataset.hasTabs,
          tabsQueryOutcome: document.documentElement.dataset.tabsQueryOutcome,
          origin: document.documentElement.dataset.origin,
          windowOrigin: document.documentElement.dataset.windowOrigin,
          storageOutcome: document.documentElement.dataset.storageOutcome,
          runtimeConnectOutcome: document.documentElement.dataset.runtimeConnectOutcome
        }))
        check('chrome.tabs is undefined in the sandboxed page', report.hasTabs === 'false', JSON.stringify(report))
        check('the sandboxed page never reached a real chrome.tabs.query call', report.tabsQueryOutcome === 'no-chrome-tabs', JSON.stringify(report))
        // window.origin, not location.origin: measured directly, this
        // Electron build's location.origin keeps reporting the ordinary
        // chrome-extension://<id> string for a CSP-sandboxed document even
        // though the real (Blink) security origin genuinely became opaque
        // (parent.chrome below throws "Blocked a frame with origin
        // \"null\"..." -- the real security property holds; only the
        // location.origin GETTER does not reflect it). window.origin does.
        check('the sandboxed page has an opaque ("null") origin, the way real Chrome\'s CSP sandbox gives it one (UPSTREAM.md patch 40)', report.windowOrigin === 'null', JSON.stringify(report))
        check('chrome.storage is unusable in the sandboxed page', report.storageOutcome === 'no-chrome-storage', JSON.stringify(report))
        check('chrome.runtime.connect is unusable in the sandboxed page', report.runtimeConnectOutcome === 'no-chrome-runtime-connect', JSON.stringify(report))

        // Main-process side: router.ts's own opaque-origin refusal
        // (UPSTREAM.md patch 37) reads WebFrameMain.origin, a different
        // property than the renderer's window.origin/location.origin --
        // confirms it is genuinely live post patch 40, not dead defence.
        const mainFrameOrigin = await (app as NonNullable<typeof app>).evaluate(({ webContents }, url: string) => {
          const wc = webContents.getAllWebContents().find((c) => c.getURL() === url)
          return wc?.mainFrame.origin
        }, sandboxTab.url())
        check('WebFrameMain.origin (the router\'s own opaque-origin check) also reads "null"', mainFrameOrigin === 'null', String(mainFrameOrigin))
      }

      // ---- framed: an ordinary extension page (framer.html) puts the
      // SAME sandbox.html in an iframe -- reachable through Playwright's
      // own per-frame CDP evaluate, never the framer page's own script,
      // which same-origin policy blocks from an opaque-origin iframe.
      const framerOpened = await waitFor(() => findFramerTab((app as NonNullable<typeof app>).windows(), extensionId) !== undefined, 15_000)
      check('the fixture opens framer.html, framing the same sandbox page', framerOpened)
      const framerTab = findFramerTab(app.windows(), extensionId)
      if (framerTab !== undefined) {
        const frameReady = await waitFor(() => framerTab.frames().some((f) => f.url() === `chrome-extension://${extensionId}/sandbox.html`))
        check('the framed sandbox page loads inside framer.html', frameReady)
        const sandboxFrame = framerTab.frames().find((f) => f.url() === `chrome-extension://${extensionId}/sandbox.html`)
        if (sandboxFrame !== undefined) {
          await waitFor(async () => await sandboxFrame.evaluate(() => document.documentElement.dataset.parentChrome !== undefined))
          const framedReport = await sandboxFrame.evaluate(() => ({
            windowOrigin: document.documentElement.dataset.windowOrigin,
            parentChrome: document.documentElement.dataset.parentChrome,
            parentDocument: document.documentElement.dataset.parentDocument
          }))
          check('the framed sandbox page also has an opaque origin', framedReport.windowOrigin === 'null', JSON.stringify(framedReport))
          check(
            'a sandboxed iframe cannot reach parent.chrome (framer.html\'s own, non-sandboxed chrome.*) -- the bypass UPSTREAM.md patch 40 closes',
            framedReport.parentChrome === 'undefined' || framedReport.parentChrome?.startsWith('threw:') === true,
            JSON.stringify(framedReport)
          )
          check(
            'a sandboxed iframe cannot reach parent.document either',
            framedReport.parentDocument === 'undefined' || framedReport.parentDocument?.startsWith('threw:') === true,
            JSON.stringify(framedReport)
          )
        }

        // ---- UPSTREAM.md patch 41: real Chromium's
        // ExtensionURLToRelativeFilePath strips ALL leading '/' and '\'
        // before resolving the file it serves -- framer.html's own four
        // more (static) iframes request the SAME sandbox.html through URL
        // variants that differ from the manifest's declared "sandbox.html"
        // entry byte-for-byte (an iframe src navigation, never routed
        // through extension-url-policy.ts's own chrome.tabs.create gate, so
        // nothing but Electron's own protocol resolution can confound the
        // result), looked up by each iframe's own `name` rather than its
        // URL: the backslash variant is measured below to resolve to the
        // IDENTICAL url the doubled-slash one does, so two frames can share
        // one url string.
        const doubledSlashFrame = await (async () => {
          await waitFor(() => findFrameByName(framerTab, 'doubled-slash')?.url().includes('sandbox.html') === true, 15_000)
          return findFrameByName(framerTab, 'doubled-slash')
        })()
        check('framer.html\'s "doubled-slash" iframe navigates somewhere', doubledSlashFrame !== undefined, doubledSlashFrame?.url())

        const backslashFrame = await (async () => {
          await waitFor(() => findFrameByName(framerTab, 'backslash')?.url().includes('sandbox.html') === true, 15_000)
          return findFrameByName(framerTab, 'backslash')
        })()
        check(
          'measured: Chromium\'s own URL parser converts a literal backslash to a forward slash for this scheme, so .../\\sandbox.html resolves to the SAME url as .../​/sandbox.html (not a distinct case)',
          backslashFrame?.url() === doubledSlashFrame?.url(),
          `doubled-slash=${String(doubledSlashFrame?.url())} backslash=${String(backslashFrame?.url())}`
        )

        const dotSegmentFrame = await (async () => {
          await waitFor(() => findFrameByName(framerTab, 'dot-segment')?.url().includes('sandbox.html') === true, 15_000)
          return findFrameByName(framerTab, 'dot-segment')
        })()
        check(
          'measured: a "/./" segment is already collapsed by the URL parser itself (WHATWG dot-segment removal), resolving to the exact canonical /sandbox.html url -- not a distinct case for isSandboxPageUrl at all',
          dotSegmentFrame?.url() === `chrome-extension://${extensionId}/sandbox.html`,
          dotSegmentFrame?.url()
        )
        if (dotSegmentFrame !== undefined) {
          const dotSegmentReport = await frameSandboxReport(dotSegmentFrame)
          check('the "/./" variant is exactly as sandboxed as the canonical page', dotSegmentReport?.hasTabs === 'false', JSON.stringify(dotSegmentReport))
        }

        if (doubledSlashFrame !== undefined) {
          const doubledSlashReport = await frameSandboxReport(doubledSlashFrame)
          check('Chromium serves the real sandbox.html for a doubled leading slash (measured)', doubledSlashReport !== undefined, JSON.stringify(doubledSlashReport))
          check('a doubled leading slash has an opaque origin, the same as the canonical sandbox.html (isSandboxPageUrl\'s own fix, UPSTREAM.md patch 41)', doubledSlashReport?.windowOrigin === 'null', JSON.stringify(doubledSlashReport))
          // A residual, not yet closed: chrome.tabs still answers real
          // data here (verified independently of Playwright, through
          // Electron's own WebFrameMain.executeJavaScript, ruling out a
          // harness artifact) even though every layer this fork controls
          // correctly refuses it -- the preload's own injectExtensionAPIs()
          // is provably never called for this exact document, and a forged
          // crx-msg from this same url IS refused by the router
          // (router-sandbox-page-refusal.test.ts's own
          // "doubled-leading-slash bypass shape" case). A303 tracks this as
          // open: the remaining source is outside this vendored fork's own
          // code (most likely Electron's own native extensions bindings),
          // so it is reported here, not silently asserted away.
        }

        const casedFrame = await (async () => {
          await waitFor(() => findFrameByName(framerTab, 'cased')?.url() !== `chrome-extension://${extensionId}/SANDBOX.html`, 15_000)
          return findFrameByName(framerTab, 'cased')
        })()
        check(
          'measured: Linux\'s case-sensitive filesystem does NOT serve the real file for a differently-cased request -- shows a network-error page instead, not a bypass on this platform (win32/darwin\'s own case-insensitive matching is covered at the unit level, in router-sandbox-page-refusal.test.ts, since this harness only ever runs on Linux)',
          casedFrame?.url() === 'chrome-error://chromewebdata/',
          casedFrame?.url()
        )
      }
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
