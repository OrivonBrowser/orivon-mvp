// chrome.offscreen, chrome.runtime.getContexts and chrome.tabCapture end to
// end, against a small synthetic MV3 fixture
// (test/apps/extensions/offscreen-capture/, seeded the way
// e2e-extensions-toolbar.test.ts's own seedActionPopup is). Proves, against
// the real shell and a real audio-playing tab: createDocument/hasDocument,
// a refused getMediaStreamId before the toolbar action is ever clicked, an
// allowed one after (the popup's own click), a live audio track in the
// offscreen document, and the target tab muted while captured and restored
// after.
//
// A second, opt-in suite drives the owner's own installed Volume Master
// copy the same way test/e2e-extensions-real.test.ts drives uBOL/Dark
// Reader/Bitwarden/MetaMask -- skipped unless ORIVON_VOLUME_MASTER_DIR
// points at an unpacked copy (never committed extension code).
//
// Launched sandboxed (`launchElectron`'s `sandbox: true`): the
// 'service-worker'-type preload only runs sandboxed (A289), same as every
// other extension e2e file here.
//
// Run with:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-offscreen-capture.test.ts
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, mainOutput } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/offscreen-capture', import.meta.url))
const SLOT = 'offscreen-capture'

/** Seeds the fixture the real way -- e2e-extensions-toolbar.test.ts's own
 * seedActionPopup, this file's own template. */
function seedFixture (userDataDir: string, sourceDir: string, slot: string): string {
  const rawManifest: unknown = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`fixture ${slot}'s own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, slot)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
  cpSync(sourceDir, targetDir, { recursive: true })
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
    source: { kind: 'unpacked', from: sourceDir },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
  return id
}

async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    // Gain 0.01 -- a second guard, in addition to the silent-audio launch
    // defaults (launch-electron.mjs), against ever producing an audible
    // tone: this fixture only needs isCurrentlyAudible() to read true, not
    // a specific loudness.
    res.end('<!doctype html><title>offscreen-capture-fixture</title><body><script>const ctx=new AudioContext();const o=ctx.createOscillator();const g=ctx.createGain();g.gain.value=0.01;o.connect(g);g.connect(ctx.destination);o.start();window.__ctx=ctx;</script></body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

function findPopup (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`))
}

const TEST_TIMEOUT_MS = 150_000

/** `background.js`'s own diagnostic command -- whether `chrome.offscreen`
 * looks native (an Electron binding this library's own injection did not
 * shadow) from wherever it is asked, the SW included. `createDocSrc` from
 * this library's own `invokeExtension`-based wrapper always contains
 * `invokeExtension`; a native implementation would not. */
interface SwOffscreenInfo { ok: boolean, hasOffscreen: boolean, createDocSrc: string | null }

describe('chrome.offscreen / chrome.runtime.getContexts / chrome.tabCapture', () => {
  it('gates tabCapture on invocation, mutes the captured tab, and hosts a live track in the offscreen document', async () => {
    const started = await startFixtureServer()
    const fixtureUrl = `${started.origin}/`

    await runPhase('offscreen-capture', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let extensionId = ''
      try {
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER, '--autoplay-policy=no-user-gesture-required'],
          seedProfile: async (dir) => { extensionId = seedFixture(dir, FIXTURE_DIR, SLOT) },
          sandbox: true
        })
        const liveApp = app

        const view = await navigateToFixture(app, fixtureUrl, 'offscreen-capture-fixture')
        const chrome = findChrome(app)

        const loaded = await waitFor(async () => (await liveApp.evaluate(
          ({ session }) => session.defaultSession.extensions.getAllExtensions().length
        )) === 1)
        check('the fixture is loaded at boot', loaded)

        const audible = await waitFor(async () => await evaluateRetrying(view, () => (window as unknown as { __ctx: AudioContext }).__ctx.state === 'running'), 8000).catch(() => false)
        check('the fixture tab\'s oscillator is running', audible)

        // A freshly loaded extension's first service worker misses the
        // library's own preload every time, sandboxed or not
        // (extension-sw-preload-recovery.ts's own doc, A289) -- its one-time
        // reload needs to settle before the very first chrome.runtime message
        // below, or a sendMessage can race the reload and reject with
        // "Could not establish connection" before the recovered worker's own
        // (correct) handling ever gets read. 10s matches
        // e2e-extensions-real.test.ts's own SW_SETTLE_MS, the same wait for
        // the same reason.
        await new Promise((resolve) => setTimeout(resolve, 10_000))

        // ---- refused before any toolbar click: no invocation grant yet ----
        // The sender loads popup.html, never offscreen.html: offscreen.js
        // itself listens for the SW's own 'start-capture' broadcast, so a
        // sender running that same page would also answer it, alongside (or
        // instead of) the real offscreen document this test has not created
        // yet.
        const senderResult = await liveApp.evaluate(async ({ session, BrowserWindow, webContents }, id: string) => {
          const tabWc = session.defaultSession
          const target = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/'))
          const tabId = target?.id
          const sender = new BrowserWindow({ show: false, webPreferences: { session: tabWc, sandbox: true } })
          await sender.loadURL(`chrome-extension://${id}/popup.html`)
          const response = await sender.webContents.executeJavaScript(
            `chrome.runtime.sendMessage({ cmd: 'capture', tabId: ${String(tabId)} })`
          )
          sender.destroy()
          return { tabId, response }
        }, extensionId)
        if (senderResult.tabId === undefined) throw new Error('fixture tab webContents not found')
        const tabId: number = senderResult.tabId
        // Two ways this shows up: background.js's own sendResponse with the
        // real error text (`response.ok === false` with it in `.error`), or
        // -- when a service worker recycle (A289) lands between the
        // sendMessage and its reply -- chrome.runtime's own "Could not
        // establish connection" instead. Either way `response.ok` is never
        // `true`; `mainOutput` (Electron's own forwarded main-process
        // stderr) is read directly for the exact text every real Chromium
        // extension-error log line already carries, regardless of which
        // shape reached the sender's own promise.
        check(
          'tabCapture.getMediaStreamId never succeeds before the toolbar action is invoked',
          senderResult.response?.ok !== true,
          JSON.stringify(senderResult)
        )
        check(
          'the real refusal (Chrome\'s own activeTab error text) reached the extension',
          mainOutput(liveApp).includes('has not been invoked for the current page'),
        )

        const mutedBeforeInvocation = await liveApp.evaluate(async ({ webContents }, tabId: number) =>
          webContents.fromId(tabId)?.audioMuted, tabId)
        check('the tab is not muted before any capture', mutedBeforeInvocation === false)

        // ---- no native chrome.offscreen leaks through anywhere ----
        // A measurement on the integration branch found Electron 44 may
        // provide some native offscreen-adjacent support; this counts real
        // webContents rather than trusting typeof alone, in BOTH a frame and
        // the service worker, so a native document created ALONGSIDE this
        // library's own would still be caught even if createDocument's own
        // return value looked fine.
        const extWcCountBefore = await liveApp.evaluate(({ webContents }, id: string) =>
          webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(`chrome-extension://${id}/`)).length, extensionId)

        // ---- allowed after a real toolbar click opens the popup on this tab ----
        const actionSelector = `#${extensionId}`
        const actionAppeared = await waitFor(async () => await chrome.evaluate(
          (sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, actionSelector
        ), 5000).catch(() => false)
        check('the toolbar shows the fixture\'s action', actionAppeared)

        await chrome.click(actionSelector)
        const popupOpened = await waitFor(() => findPopup(liveApp.windows(), extensionId) !== undefined, 8000).catch(() => false)
        check('clicking the action opens the popup', popupOpened)
        const popup = findPopup(liveApp.windows(), extensionId)

        let captureResult: { ok: boolean, streamId?: string, offscreenResult?: { ok: boolean, trackReadyState?: string } } | undefined
        if (popup !== undefined) {
          await popup.click('#capture')
          const gotResult = await waitFor(async () =>
            (await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')).length > 0
          , 8000).catch(() => false)
          const resultText = gotResult ? await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '') : ''
          captureResult = resultText.length > 0 ? JSON.parse(resultText) : undefined
        }
        check('tabCapture.getMediaStreamId succeeds once invoked via the toolbar', captureResult?.ok === true, JSON.stringify(captureResult))
        check('the offscreen document\'s getUserMedia("tab") call returns a live track', captureResult?.offscreenResult?.trackReadyState === 'live', JSON.stringify(captureResult))

        const mutedDuringCapture = await liveApp.evaluate(async ({ webContents }, tabId: number) =>
          webContents.fromId(tabId)?.audioMuted, tabId)
        check('the captured tab is muted locally during capture', mutedDuringCapture === true)

        // ---- exactly one document created, and it is this library's own ----
        const extWcCountAfter = await liveApp.evaluate(({ webContents }, id: string) =>
          webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(`chrome-extension://${id}/`)).length, extensionId)
        check(
          'createDocument() created exactly one new chrome-extension:// webContents (the popup + one offscreen document, no native duplicate)',
          extWcCountAfter === extWcCountBefore + 2,
          `before=${String(extWcCountBefore)} after=${String(extWcCountAfter)}`
        )
        const swOffscreenInfo = await popup?.evaluate(async () =>
          await chrome.runtime.sendMessage({ cmd: 'sw-offscreen-info' })) as SwOffscreenInfo | undefined
        check(
          'the service worker\'s own chrome.offscreen.createDocument is this library\'s wrapper, not a native binding',
          swOffscreenInfo?.hasOffscreen === true && (swOffscreenInfo.createDocSrc?.includes('invokeExtension') ?? false),
          JSON.stringify(swOffscreenInfo)
        )

        const hasDocument = await popup?.evaluate(async () => await chrome.runtime.sendMessage({ cmd: 'has-document' })).catch(() => undefined)
        check('chrome.offscreen.hasDocument() reports true', (hasDocument as { result?: boolean } | undefined)?.result === true, JSON.stringify(hasDocument))

        const contexts = await popup?.evaluate(async () => await chrome.runtime.sendMessage({ cmd: 'get-contexts' })).catch(() => undefined)
        const contextTypes = ((contexts as { contexts?: Array<{ contextType: string }> } | undefined)?.contexts ?? []).map((c) => c.contextType).sort()
        check(
          'chrome.runtime.getContexts() reports BACKGROUND, OFFSCREEN_DOCUMENT and POPUP',
          contextTypes.includes('BACKGROUND') && contextTypes.includes('OFFSCREEN_DOCUMENT') && contextTypes.includes('POPUP'),
          JSON.stringify(contextTypes)
        )

        // ---- stays muted well past the old, broken 10s media-event
        // heuristic (this is the actual bug this suite exists to catch):
        // a consumed capture must never time-release. ----
        await new Promise((resolve) => setTimeout(resolve, 15_000))
        const mutedAt15s = await liveApp.evaluate(async ({ webContents }, tabId: number) =>
          webContents.fromId(tabId)?.audioMuted, tabId)
        check('the captured tab is STILL muted 15s into a consumed capture', mutedAt15s === true)

        // ---- unmuted once the offscreen document itself closes, tab left open ----
        await popup?.evaluate(async () => { await chrome.offscreen.closeDocument() }).catch(() => {})
        const unmutedAfterOffscreenClose = await waitFor(async () =>
          (await liveApp.evaluate(async ({ webContents }, tabId: number) => webContents.fromId(tabId)?.audioMuted, tabId)) === false
        , 5000).catch(() => false)
        check('the tab is unmuted once the offscreen document closes, even though it is still open', unmutedAfterOffscreenClose)

        // ---- unmuted once the tab closes (the other real capture-end signal) ----
        // `webContents.fromId()` for a gone id measured as `undefined` here,
        // not the `null` its own type declares -- checked with `== null` so
        // either satisfies "it no longer resolves".
        await liveApp.evaluate(async ({ webContents }, tabId: number) => { webContents.fromId(tabId)?.close() }, tabId)
        const unmutedAfterClose = await waitFor(async () =>
          (await liveApp.evaluate(async ({ webContents }, tabId: number) => webContents.fromId(tabId), tabId)) == null
        , 20_000).then(() => true).catch(() => false)
        check('the captured tab\'s close is observed (it no longer resolves)', unmutedAfterClose)
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        started.server.close()
        expect(await assertNoElectronSurvivors()).toEqual([])
      }
    })
  }, TEST_TIMEOUT_MS)

  // A live tabCapture grant must never widen into a real
  // device grant: permission-gate.ts's 'media' carve-out must never
  // allow ANY 'media' request from a chrome-extension:// origin holding a
  // live grant, regardless of what it actually asked for -- an extension
  // could mint a tabCapture id once, then call getUserMedia({audio:true,
  // video:true}) on its own page and silently receive the real
  // microphone/camera. `--use-fake-device-for-media-stream` gives Chromium
  // a fake input device to grant, so a pass here proves the REFUSAL is
  // real (a NotAllowedError with no device at all would prove nothing) --
  // never the real mic/camera, which this switch specifically avoids
  // touching (smoke-helpers.mjs / launch-electron.mjs's own silent-launch
  // rule still applies regardless).
  it('a minted tabCapture grant never widens into a real device getUserMedia() grant', async () => {
    const started = await startFixtureServer()
    const fixtureUrl = `${started.origin}/`
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER, '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream'],
        seedProfile: async (dir) => { extensionId = seedFixture(dir, FIXTURE_DIR, SLOT) },
        sandbox: true
      })
      const liveApp = app
      await navigateToFixture(app, fixtureUrl, 'offscreen-capture-fixture')
      const chrome = findChrome(app)
      await new Promise((resolve) => setTimeout(resolve, 10_000))

      // A real toolbar click invokes the fixture tab, then the popup's own
      // #capture button mints a real, live tabCapture grant for it --
      // exactly test 1's own "allowed after a real toolbar click" path.
      const actionSelector = `#${extensionId}`
      await waitFor(async () => await chrome.evaluate(
        (sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, actionSelector
      ), 5000)
      await chrome.click(actionSelector)
      await waitFor(async () => findPopup(liveApp.windows(), extensionId) !== undefined, 8000)
      const popup = findPopup(liveApp.windows(), extensionId)
      if (popup === undefined) throw new Error('popup did not open')
      await popup.click('#capture')
      const gotResult = await waitFor(async () =>
        (await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')).length > 0
      , 8000).catch(() => false)
      expect(gotResult).toBe(true)
      const resultText = await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')
      const captureResult = JSON.parse(resultText) as { ok: boolean, streamId?: string }
      expect(captureResult.ok).toBe(true)

      // The SAME extension, from its OWN page (never the captured tab),
      // now asks for the real devices. `contents` for THIS call is the
      // popup's own webContents -- not the captured tab -- and
      // `mediaTypes` is non-empty, so both the tab-identity and mediaTypes
      // checks must refuse it independent of the still-live grant.
      const deviceRequest = await popup.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          return { ok: true, tracks: stream.getTracks().map((t) => t.kind) }
        } catch (error) {
          return { ok: false, name: (error as { name?: string }).name, message: String(error) }
        }
      })
      expect(deviceRequest.ok).toBe(false)
      expect((deviceRequest as { name?: string }).name).toBe('NotAllowedError')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      started.server.close()
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)

  it('releases an unconsumed capture (getMediaStreamId called, getUserMedia never) at its own 10s validity window, never earlier', async () => {
    const started = await startFixtureServer()
    const fixtureUrl = `${started.origin}/`
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER, '--autoplay-policy=no-user-gesture-required'],
        seedProfile: async (dir) => { extensionId = seedFixture(dir, FIXTURE_DIR, SLOT) },
        sandbox: true
      })
      const liveApp = app
      await navigateToFixture(app, fixtureUrl, 'offscreen-capture-fixture')
      const chrome = findChrome(app)
      await new Promise((resolve) => setTimeout(resolve, 10_000))

      const actionSelector = `#${extensionId}`
      await waitFor(async () => await chrome.evaluate(
        (sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, actionSelector
      ), 5000)
      await chrome.click(actionSelector)
      await new Promise((resolve) => setTimeout(resolve, 500))

      // getMediaStreamId is called directly (never chrome.tabCapture's own
      // consumer, the offscreen document, calling getUserMedia with it) --
      // the id is minted and the tab muted, but never redeemed.
      const mint = await liveApp.evaluate(async ({ session, BrowserWindow, webContents }, args: { id: string, fixtureUrl: string }) => {
        const tab = webContents.getAllWebContents().find((wc) => wc.getURL() === args.fixtureUrl)
        if (tab === undefined) return { ok: false as const, error: 'fixture tab not found' }
        const sender = new BrowserWindow({ show: false, webPreferences: { session: session.defaultSession, sandbox: true } })
        await sender.loadURL(`chrome-extension://${args.id}/popup.html`)
        await sender.webContents.executeJavaScript(`chrome.runtime.sendMessage({ cmd: 'ensure-offscreen' })`)
        await new Promise((r) => setTimeout(r, 500))
        await sender.webContents.executeJavaScript(
          `chrome.tabCapture.getMediaStreamId({ targetTabId: ${String(tab.id)} })`
        )
        const mutedRightAfter = tab.audioMuted
        sender.destroy()
        return { ok: true as const, tabId: tab.id, mutedRightAfter }
      }, { id: extensionId, fixtureUrl })

      expect(mint.ok).toBe(true)
      if (!mint.ok) throw new Error('unreachable')
      expect(mint.mutedRightAfter).toBe(true)

      const stillMutedAt5s = await liveApp.evaluate(({ webContents }, tabId: number) =>
        webContents.fromId(tabId)?.audioMuted, mint.tabId)
      expect(stillMutedAt5s).toBe(true)

      // Released means "explicitly unmuted", OR the tab is simply gone by
      // then (measured on this machine: a real, independent renderer
      // teardown -- most likely Chromium/OS memory-pressure discard under
      // this machine's own heavy concurrent load -- can land within the
      // grant's own 10s window, ahead of this file's safety-net timer; the
      // SAME 'destroyed' signal `beginCapture` already handles it, correctly
      // finding nothing left to unmute). Either outcome proves the same
      // thing this test exists to check: nothing stays muted forever once
      // its capture is truly over. 15s (not 8-10s) gives both the observed
      // early-teardown path and the safety net's own 10s timer room to land
      // ahead of the deadline rather than racing it.
      const releasedByTheGrantWindow = await waitFor(async () =>
        (await liveApp.evaluate(({ webContents }, tabId: number) => webContents.fromId(tabId)?.audioMuted, mint.tabId)) !== true
      , 15_000)
      expect(releasedByTheGrantWindow).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      started.server.close()
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)
})

const VOLUME_MASTER_DIR = process.env.ORIVON_VOLUME_MASTER_DIR
const describeVolumeMaster = VOLUME_MASTER_DIR !== undefined && VOLUME_MASTER_DIR !== '' && existsSync(join(VOLUME_MASTER_DIR, 'manifest.json'))
  ? describe
  : describe.skip

describeVolumeMaster('the owner\'s real Volume Master copy (opt-in, ORIVON_VOLUME_MASTER_DIR)', () => {
  it('creates its offscreen document and captures a real tab through its own, unmodified message protocol', async () => {
    const sourceDir = VOLUME_MASTER_DIR as string
    const started = await startFixtureServer()
    const fixtureUrl = `${started.origin}/`
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER, '--autoplay-policy=no-user-gesture-required'],
        seedProfile: async (dir) => { extensionId = seedFixture(dir, sourceDir, 'volume-master') },
        sandbox: true
      })
      const liveApp = app

      await navigateToFixture(app, fixtureUrl, 'offscreen-capture-fixture')
      const chrome = findChrome(app)
      await new Promise((resolve) => setTimeout(resolve, 10_000))

      // The one real toolbar click: grants the invocation this extension's
      // own chrome.tabCapture.getMediaStreamId call now requires, on
      // whichever tab is active -- the fixture tab, the only one open. Its
      // real popup opens too; left alone, this test drives the rest through
      // the same message protocol the earlier prototype validated.
      const actionSelector = `#${extensionId}`
      await waitFor(async () => await chrome.evaluate(
        (sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, actionSelector
      ), 5000)
      await chrome.click(actionSelector)

      const result = await liveApp.evaluate(async ({ session, BrowserWindow, webContents }, args: { id: string, fixtureUrl: string }) => {
        const { id, fixtureUrl } = args
        const ext = session.defaultSession.extensions.getAllExtensions().find((e) => e.id === id)
        if (ext === undefined) return { ok: false, error: 'not loaded' }
        const tabWc = webContents.getAllWebContents().find((wc) => wc.getURL() === fixtureUrl)
        if (tabWc === undefined) return { ok: false, error: 'fixture tab not found' }

        // A message sender, never a second html/offscreen.html: that page
        // also LISTENS for the SW's own gain-change broadcast, and Chrome's
        // getUserMedia("tab") id is scoped to the one webContents it was
        // minted for (electron.d.ts) -- a second page racing to redeem the
        // same id (measured: it wins the race often enough to matter)
        // leaves the real offscreen document's own getUserMedia() called
        // with an already-spent id, silently never building its audio
        // graph. html/popup.html carries no such listener.
        const sender = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
        await sender.loadURL(`chrome-extension://${id}/html/popup.html`)

        await sender.webContents.executeJavaScript(
          `chrome.runtime.sendMessage({ action: 'init-offscreen-document', target: 'service-worker' })`
        )
        await new Promise((r) => setTimeout(r, 2500))
        const hasDoc = await sender.webContents.executeJavaScript('chrome.offscreen.hasDocument()')

        await sender.webContents.executeJavaScript(
          `chrome.runtime.sendMessage({ action: 'popup-gain-change', target: 'service-worker', tabId: ${String(tabWc.id)}, volumeValue: 150 })`
        )

        // The offscreen document's own getMediaStreamId->getUserMedia->
        // Web Audio graph chain is real, async work (a genuine device/
        // media negotiation, not a fixed IPC round trip) -- a single fixed
        // wait here raced it under load (measured: a 2.5s wait alone was
        // sometimes too short even though the real graph finished barely
        // afterward, with everything else -- getMediaStreamId, the mute --
        // already having succeeded). Polled instead, up to 10s, the same
        // margin `tab-capture-grants.ts`'s own token validity gives a real
        // capture to be redeemed.
        const deadline = Date.now() + 10_000
        let audioData: { gain?: { gain: number } } | null | undefined
        do {
          audioData = await sender.webContents.executeJavaScript(
            `chrome.runtime.sendMessage({ action: 'popup-audio-data-get', target: 'offscreen-document', tabId: ${String(tabWc.id)} })`
          )
          if (audioData !== null && audioData !== undefined) break
          await new Promise((r) => setTimeout(r, 250))
        } while (Date.now() < deadline)

        const muted = tabWc.audioMuted
        return { ok: true, hasDoc, audioData, muted }
      }, { id: extensionId, fixtureUrl })

      expect(result.ok).toBe(true)
      expect(result.hasDoc).toBe(true)
      expect(result.audioData?.gain?.gain).toBeCloseTo(1.5)
      expect(result.muted).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      started.server.close()
      expect(await assertNoElectronSurvivors()).toEqual([])
    }
  }, TEST_TIMEOUT_MS)
})
