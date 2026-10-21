// The offscreen document's own lifecycle and navigation policy: process
// exit, window.open denial and renderer-crash cleanup. Kept separate from
// test/extensions/e2e-extensions-offscreen-capture.test.ts because none of these
// actually exercise tabCapture itself. Reuses that file's own fixture
// (test/apps/extensions/offscreen-capture/) and seeding helper shape.
//
// Run with:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-offscreen-lifecycle.test.ts
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../../src/main/extensions/registry.js'
import { resolveSlotKey } from '../../src/main/extensions/install-runner.js'
import { generateId } from '../../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('../apps/extensions/offscreen-capture', import.meta.url))
const SLOT = 'offscreen-capture'

function seedFixture (userDataDir: string): string {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`fixture ${SLOT}'s own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, SLOT)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', SLOT, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const id = generateId(key)
  const now = Date.now()
  const entry: InstalledExtension = {
    id, name: parsed.facts.name, version: parsed.facts.version, enabled: true,
    installedAt: now, updatedAt: now,
    source: { kind: 'unpacked', from: FIXTURE_DIR },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir, stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
  return id
}

/** Creates the fixture's offscreen document through its own real
 * background.js 'ensure-offscreen' handler, via a hidden sender page --
 * the same shape every other file here uses, never a direct main-process
 * call. Returns once chrome.offscreen.hasDocument() reads back true. */
async function ensureOffscreenDocument (app: Awaited<ReturnType<typeof launchElectron>>, extensionId: string): Promise<void> {
  const hasDoc = await app.evaluate(async ({ session, BrowserWindow }, id: string) => {
    const sender = new BrowserWindow({ show: false, webPreferences: { session: session.defaultSession, sandbox: true } })
    await sender.loadURL(`chrome-extension://${id}/popup.html`)
    await sender.webContents.executeJavaScript(`chrome.runtime.sendMessage({ cmd: 'ensure-offscreen' })`)
    const result = await sender.webContents.executeJavaScript(`chrome.runtime.sendMessage({ cmd: 'has-document' })`)
    sender.destroy()
    return result
  }, extensionId)
  expect((hasDoc as { result?: boolean } | undefined)?.result).toBe(true)
}

const TEST_TIMEOUT_MS = 60_000

/** `/a` answers with a real HTTP 302 to `/b` -- MEASURED (electron.d.ts):
 * `'will-navigate'` is documented as firing "on the main frame" only (it
 * never fires for a subframe's own navigation at all, so a plain
 * `iframe.src = ...` assignment is not the shape that actually exercises
 * this item), while `'will-redirect'` fires "when a server side redirect
 * occurs during navigation" -- in ANY frame, main or sub -- with no
 * main-frame restriction documented at all. A real 302 is what makes the
 * subframe's OWN `'will-redirect'` fire, which is the one event this test
 * needs a real navigation was not blocked. */
async function startRedirectServer (): Promise<{ server: Server, origin: string, pageA: string, pageB: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { location: '/b' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>page-b</title><body></body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('redirect server did not report a port')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return { server, origin, pageA: `${origin}/a`, pageB: `${origin}/b` }
}

describe('offscreen document lifecycle and navigation policy', () => {
  // Measured directly (docs/planning's tabCapture/offscreen
  // probe): a never-attached WebContentsView contributes nothing to
  // BrowserWindow.getAllWindows(), so it can no longer keep the process
  // alive past the last real shell window closing -- src/main/index.ts's
  // own 'window-all-closed' handler quits unconditionally on this
  // platform (`runtime.isPrivate || process.platform !== 'darwin'`, always
  // true off macOS). Before this fix, the offscreen document was a hidden
  // BrowserWindow, which DOES count, and the process stayed resident with
  // no window on screen at all.
  it('closing the last shell window quits the process even with an offscreen document open', async () => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedFixture(dir) },
        sandbox: true
      })
      const liveApp = app
      await new Promise((resolve) => setTimeout(resolve, 3000))

      await ensureOffscreenDocument(liveApp, extensionId)

      const pid = liveApp.process().pid
      if (pid === undefined) throw new Error('no pid for the launched app')

      // The thing proven: the offscreen document does not stop Electron emitting window-all-closed. Off macOS the
      // browser quits on it; on macOS it stays resident (src/main/index.ts), so it is quit explicitly below.
      await liveApp.evaluate(({ app: electronApp, BaseWindow }) => {
        const seen = globalThis as { __windowAllClosed?: boolean }
        seen.__windowAllClosed = false
        electronApp.once('window-all-closed', () => { seen.__windowAllClosed = true })
        for (const win of BaseWindow.getAllWindows()) win.close()
      })
      if (process.platform === 'darwin') {
        const emitted = await waitFor(async () => await liveApp.evaluate(() => (globalThis as { __windowAllClosed?: boolean }).__windowAllClosed === true), 15_000)
        expect(emitted).toBe(true)
        void liveApp.evaluate(({ app: electronApp }) => { electronApp.quit() }).catch(() => {})
      }

      const exited = await waitFor(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }, 15_000).catch(() => false)
      expect(exited).toBe(true)
      app = undefined // already gone; nothing left for the finally block's own close to do
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)

  // window.open from the offscreen document must never create a
  // window at all -- it has no tab, no toolbar, and no one watching it.
  it('window.open() from the offscreen document is denied outright', async () => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedFixture(dir) },
        sandbox: true
      })
      const liveApp = app
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await ensureOffscreenDocument(liveApp, extensionId)

      const result = await liveApp.evaluate(async ({ webContents }, id: string) => {
        const offscreen = webContents.getAllWebContents().find((wc) => wc.getURL() === `chrome-extension://${id}/offscreen.html`)
        if (offscreen === undefined) return { ok: false, error: 'offscreen webContents not found' }
        const opened = await offscreen.executeJavaScript(`!!window.open('https://example.com/', '_blank')`)
        // The only thing this denial actually promises: no webContents ever
        // loads example.com at all -- `getAllWebContents()`'s own count
        // otherwise races unrelated teardown (the sender page
        // ensureOffscreenDocument used to create this document is
        // destroyed around the same time), which is not what this test is
        // about.
        const exampleComOpened = webContents.getAllWebContents().some((wc) => wc.getURL().startsWith('https://example.com/'))
        return { ok: true, opened, exampleComOpened }
      }, extensionId)

      expect(result.ok).toBe(true)
      expect((result as { opened?: boolean }).opened).toBe(false)
      expect((result as { exampleComOpened?: boolean }).exampleComOpened).toBe(false)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)

  // Navigation is locked to the extension's own origin.
  it('the offscreen document cannot navigate itself away from its own extension origin', async () => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedFixture(dir) },
        sandbox: true
      })
      const liveApp = app
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await ensureOffscreenDocument(liveApp, extensionId)

      const result = await liveApp.evaluate(async ({ webContents }, id: string) => {
        const offscreen = webContents.getAllWebContents().find((wc) => wc.getURL() === `chrome-extension://${id}/offscreen.html`)
        if (offscreen === undefined) return { ok: false, error: 'offscreen webContents not found' }
        const before = offscreen.getURL()
        // `will-navigate` fires for a RENDERER-initiated navigation, never
        // a main-process `loadURL()` call (Electron's own documented
        // distinction) -- `window.location = ...`, run from inside the
        // page's own script, is the shape this navigation policy actually
        // has to refuse: an offscreen document's own (possibly compromised) page
        // navigating itself, not this test harness calling loadURL().
        await offscreen.executeJavaScript(`window.location = 'https://example.com/'`).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return { ok: true, before, after: offscreen.getURL() }
      }, extensionId)

      expect(result.ok).toBe(true)
      expect((result as { after?: string }).after).toBe((result as { before?: string }).before)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)

  // `will-redirect` fires for a server-side redirect in ANY frame, main or
  // sub (electron.d.ts has no main-frame restriction on it, unlike
  // `will-navigate`, which is documented to fire "on the main frame" only
  // and so never even sees a plain subframe navigation at all) -- the lock
  // above must apply to the offscreen DOCUMENT's own main-frame redirects,
  // never to a cross-origin <iframe> that document deliberately embeds
  // being redirected by its own server.
  it('a real HTTP redirect inside a cross-origin iframe is not blocked by the offscreen document\'s own navigation lock', async () => {
    const { server, pageA, pageB } = await startRedirectServer()
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedFixture(dir) },
        sandbox: true
      })
      const liveApp = app
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await ensureOffscreenDocument(liveApp, extensionId)

      const result = await liveApp.evaluate(async ({ webContents }, args: { id: string, pageA: string, pageB: string }) => {
        const offscreen = webContents.getAllWebContents().find((wc) => wc.getURL() === `chrome-extension://${args.id}/offscreen.html`)
        if (offscreen === undefined) return { ok: false as const, error: 'offscreen webContents not found' }

        const subframeRedirects: string[] = []
        offscreen.on('will-redirect', (details) => {
          if (!details.isMainFrame) subframeRedirects.push(details.url)
        })
        const subframeLoads: string[] = []
        offscreen.on('did-frame-navigate', (_event, url, _httpCode, _statusText, isMainFrame) => {
          if (!isMainFrame) subframeLoads.push(url)
        })

        const loaded = await offscreen.executeJavaScript(`
          new Promise((resolve) => {
            const f = document.createElement('iframe')
            f.src = ${JSON.stringify(args.pageA)}
            f.onload = () => resolve(true)
            f.onerror = () => resolve(false)
            document.body.appendChild(f)
          })
        `)

        return { ok: true as const, loaded, subframeRedirects, subframeLoads }
      }, { id: extensionId, pageA, pageB })

      expect(result.ok).toBe(true)
      const { loaded, subframeRedirects, subframeLoads } = result as { loaded?: boolean, subframeRedirects?: string[], subframeLoads?: string[] }
      // `will-redirect`'s own `details.url` is the redirect TARGET
      // (electron.d.ts), so this fires once, naming pageB.
      expect(subframeRedirects).toEqual([pageB])
      expect(loaded).toBe(true)
      expect(subframeLoads).toEqual([pageB])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      server.close()
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)

  // A crashed offscreen renderer must stop being reported, and a
  // fresh createDocument() must succeed again afterward.
  it('a crashed offscreen document stops being reported and a fresh one can be created', async () => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedFixture(dir) },
        sandbox: true
      })
      const liveApp = app
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await ensureOffscreenDocument(liveApp, extensionId)

      // `forcefullyCrashRenderer()` (Chromium's own simulated-crash IPC)
      // MEASURED to hang this harness outright under xvfb + a sandboxed
      // WebContentsView: reproduced twice, deterministically, as a FATAL
      // "Crashing because hung" from Chromium's OWN child-process watchdog,
      // unrelated to anything this fix's own render-process-gone handler
      // does (it hung identically with that handler doing nothing at all
      // but deleting a map entry). Killing the render process's real OS
      // pid directly is what every other Electron test suite uses to
      // reproduce 'render-process-gone' without going through that IPC
      // command at all, and is a strictly stronger test of this fix besides:
      // the handler must react correctly to an OS-level render-process
      // death, not only Chromium's own simulated one.
      const osPid = await liveApp.evaluate(({ webContents }, id: string) => {
        const offscreen = webContents.getAllWebContents().find((wc) => wc.getURL() === `chrome-extension://${id}/offscreen.html`)
        return offscreen?.getOSProcessId()
      }, extensionId)
      if (osPid === undefined) throw new Error('offscreen webContents not found')
      process.kill(osPid, 'SIGKILL')

      // A single fixed wait, not a tight poll: the crash's own
      // 'render-process-gone' round trip is what this test is measuring,
      // and creating a fresh sender BrowserWindow on every poll tick
      // (this file's only way to ask hasDocument(), a real extension API)
      // adds load of its own under xvfb that is not what this test is about.
      await new Promise((resolve) => setTimeout(resolve, 5000))

      const hasDocAfterCrash = await liveApp.evaluate(async ({ session, BrowserWindow }, id: string) => {
        const sender = new BrowserWindow({ show: false, webPreferences: { session: session.defaultSession, sandbox: true } })
        await sender.loadURL(`chrome-extension://${id}/popup.html`)
        const response = await sender.webContents.executeJavaScript(`chrome.runtime.sendMessage({ cmd: 'has-document' })`)
        sender.destroy()
        return (response as { result?: boolean } | undefined)?.result
      }, extensionId)
      expect(hasDocAfterCrash).toBe(false)

      // A fresh createDocument() must succeed, not throw "Only a single
      // offscreen document may be created." for a document that can no
      // longer do anything.
      await ensureOffscreenDocument(liveApp, extensionId)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, 90_000)
})
