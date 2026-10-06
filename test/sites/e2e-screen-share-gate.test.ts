// The gate that decides which request for the screen is granted (ADR-0055), proved from a real page with the
// test-only picker standing in for the person: a share of a screen or a tab, a cancel, the legacy
// `getUserMedia({ chromeMediaSource })` paths and a call from a realm the preload did not wrap all refused with
// the picker never shown, the site's block, Stop reaching the page's track and its clone, navigation ending a share,
// and two calls at once in one tab. Fake pickers only: no real dialog, no window, no sound.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SUSPECT_MS } from '../../src/main/display-capture/display-tickets.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const E2E_TIMEOUT_MS = 240_000

const PAGE = (name: string): string => `<!doctype html><title>${name}</title><body><button id="go">go</button>
<script>
window.__r = {}
window.__got = []
const done = (key, promise) => promise.then((value) => { window.__r[key] = value }, (error) => { window.__r[key] = 'ERR:' + error.name })
const describe = (stream) => { const track = stream.getVideoTracks()[0]; return { tracks: stream.getTracks().length, state: track.readyState, surface: track.getSettings().displaySurface, label: track.label } }
window.share = (key, options) => done(key, navigator.mediaDevices.getDisplayMedia(options).then((stream) => {
  window.__stream = stream
  window.__got.push(stream)
  stream.getVideoTracks()[0].addEventListener('ended', () => { window.__r.ended = (window.__r.ended || 0) + 1 })
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = stream
  document.body.append(video)
  video.play().catch(() => {})
  window.__video = video
  return describe(stream)
}))
const keep = (stream) => { window.__got.push(stream); return describe(stream) }
window.legacy = (key, video) => done(key, navigator.mediaDevices.getUserMedia({ video }).then(keep))
window.native = (key) => { const frame = document.createElement('iframe'); document.body.append(frame); done(key, frame.contentWindow.MediaDevices.prototype.getDisplayMedia.call(navigator.mediaDevices, { video: true }).then(keep)) }
window.live = () => window.__got.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === 'live').length
window.cloneIt = () => { window.__clone = window.__stream.getVideoTracks()[0].clone(); window.__clone.addEventListener('ended', () => { window.__r.cloneEnded = true }) }
window.frames = () => window.__video.getVideoPlaybackQuality().totalVideoFrames
window.fromFrame = (key) => { const frame = document.createElement('iframe'); document.body.append(frame); done(key, frame.contentWindow.navigator.mediaDevices.getDisplayMedia({ video: true }).then(describe)) }
window.__next = () => {}
document.getElementById('go').addEventListener('click', () => window.__next())
</script></body>`

const servers: FixtureServer[] = []
const origins = { a: '', b: '' }

beforeAll(async () => {
  for (const [key, name] of [['a', 'share-a'], ['b', 'share-b']] as const) {
    const server = await startServer((_request, response) => { html(response, PAGE(name)) })
    servers.push(server)
    origins[key] = server.origin
  }
})

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication
interface Hook {
  use: (mode: unknown) => void
  calls: unknown[]
  reset: () => void
  shares: () => Array<{ id: string, kind: string, label: string, origin: string, audio: boolean }>
  stop: (id: string) => void
}
const useChooser = async (app: App, mode: unknown): Promise<void> => { await app.evaluate((_electron, m) => { (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.use(m) }, mode) }
const chooserCalls = async (app: App): Promise<number> => await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.calls.length)
const resetChooser = async (app: App): Promise<void> => { await app.evaluate(() => { (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.reset() }) }
const shares = async (app: App): Promise<ReturnType<Hook['shares']>> => await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.shares())
const stopShare = async (app: App, id: string): Promise<void> => { await app.evaluate((_electron, shareId) => { (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.stop(shareId) }, id) }
const setSetting = async (app: App, key: string, value: unknown): Promise<void> => {
  await app.evaluate((_electron, [k, v]) => { (globalThis as unknown as { __orivonDevSidePanel: { setSetting: (k: string, v: unknown) => void } }).__orivonDevSidePanel.setSetting(k as string, v) }, [key, value])
}

const result = async (view: Page, key: string, timeoutMs = 15_000): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key); return last !== undefined }, timeoutMs)
  return last
}
const run = async (view: Page, body: string): Promise<void> => {
  await view.evaluate((code) => { (window as unknown as { __next: () => void }).__next = new Function(code) as () => void }, body)
  await view.click('#go')
}
const frames = async (view: Page): Promise<number> => await view.evaluate(() => (window as unknown as { frames: () => number }).frames())

it('grants only the call the preload makes after the pick, and refuses every other way to the screen', async () => {
  const { app, chrome } = await launchShell()
  try {
    const url = `${origins.a}/`
    const view = await visit(app, chrome, url)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser?: unknown }).__orivonDevDisplayChooser)) !== undefined)).toBe(true)

    // The permission query says the page may ask.
    expect(await view.evaluate(async () => (await navigator.permissions.query({ name: 'display-capture' as PermissionName })).state)).toBe('granted')

    // A cancel: the page gets NotAllowedError and the picker was asked once.
    await useChooser(app, { kind: 'cancel' })
    await run(view, "window.share('cancelled', { video: true })")
    expect(await result(view, 'cancelled')).toBe('ERR:NotAllowedError')
    expect(await chooserCalls(app)).toBe(1)

    // A screen: a live monitor track, with frames, and a share in the registry for this site.
    await useChooser(app, { kind: 'screen' })
    await run(view, "window.share('screen', { video: { displaySurface: 'monitor' } })")
    expect(await result(view, 'screen')).toMatchObject({ tracks: 1, state: 'live', surface: 'monitor' })
    expect(await waitFor(async () => (await frames(view)) > 0, 20_000)).toBe(true)
    const list = await shares(app)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'screen', origin: origins.a, audio: false })
    expect(await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.calls.at(-1))).toMatchObject({ origin: origins.a, isApp: false, audio: false, hints: { displaySurface: 'monitor' } })

    // Stop: the page's track ends and its listener runs, so does the page's clone, and the registry empties.
    await view.evaluate(() => { (window as unknown as { cloneIt: () => void }).cloneIt() })
    await stopShare(app, (list[0] as { id: string }).id)
    expect(await result(view, 'ended')).toBe(1)
    expect(await result(view, 'cloneEnded')).toBe(true)
    expect(await view.evaluate(() => [(window as unknown as { __stream: MediaStream }).__stream.getVideoTracks()[0]?.readyState, (window as unknown as { __clone: MediaStreamTrack }).__clone.readyState])).toEqual(['ended', 'ended'])
    expect(await waitFor(async () => (await shares(app)).length === 0)).toBe(true)

    // The legacy paths take the same permission request: refused, with the picker never asked. They come after the
    // suspicion that follows a served share has lapsed: inside it they would end the page's renderer (below).
    await delay(SUSPECT_MS + 500)
    const asked = await chooserCalls(app)
    await run(view, "window.legacy('desktop', { mandatory: { chromeMediaSource: 'desktop' } })")
    expect(await result(view, 'desktop')).toBe('ERR:NotAllowedError')
    await run(view, "window.legacy('desktopId', { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } })")
    expect(await result(view, 'desktopId')).toBe('ERR:NotAllowedError')
    await run(view, "window.legacy('tab', { mandatory: { chromeMediaSource: 'tab' } })")
    expect(String(await result(view, 'tab'))).toMatch(/^ERR:/)
    await run(view, "window.legacy('tabId', { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'web-contents-media-stream://1:1' } })")
    expect(String(await result(view, 'tabId'))).toMatch(/^ERR:/)
    // A call from a fresh realm the preload did not wrap reaches the gate with no ticket.
    await run(view, "window.fromFrame('frame')")
    expect(await result(view, 'frame')).toBe('ERR:NotAllowedError')
    expect(await chooserCalls(app)).toBe(asked)
    expect(await shares(app)).toEqual([])

    // Each of those marked the page suspect: its own next call waits until that lapses.
    await delay(SUSPECT_MS + 500)

    // Two calls at once in one tab: the second is refused while the first picker is open.
    await useChooser(app, { kind: 'screen', delayMs: 1500 })
    await run(view, "window.share('first', { video: true }); window.share('second', { video: true })")
    expect(await result(view, 'second')).toBe('ERR:NotAllowedError')
    expect(await result(view, 'first', 30_000)).toMatchObject({ state: 'live', surface: 'monitor' })
    expect(await chooserCalls(app)).toBe(asked + 1)
    await stopShare(app, ((await shares(app))[0] as { id: string }).id)
    expect(await waitFor(async () => (await shares(app)).length === 0)).toBe(true)

    // Navigation ends a share.
    await useChooser(app, { kind: 'screen' })
    await run(view, "window.share('screen2', { video: true })")
    expect(await result(view, 'screen2')).toMatchObject({ state: 'live' })
    expect((await shares(app))).toHaveLength(1)
    await view.reload()
    expect(await waitFor(async () => (await shares(app)).length === 0)).toBe(true)

    expect(mainOutput(app)).not.toMatch(/reached no display handler/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('shares a tab as a browser surface, ends when the tab is not captured any more, and obeys the site\'s block', async () => {
  const { app, chrome } = await launchShell()
  try {
    const urlA = `${origins.a}/`
    const urlB = `${origins.b}/`
    const view = await visit(app, chrome, urlA)
    const [first] = await tabIds(chrome)
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, urlB)
    expect((await waitForTab(chrome, { address: urlB })).ok).toBe(true)
    const second = (await tabIds(chrome)).at(-1) as string
    await chrome.click(`.tab[data-id="${first as string}"]`)
    expect(await waitFor(() => findViewShowing(app, chrome, urlA) !== undefined)).toBe(true)

    // A tab in the background of the window cannot be captured (Chromium answers AbortError), and the failed share
    // leaves nothing running.
    await useChooser(app, { kind: 'tab', url: origins.b })
    await run(view, "window.share('background', { video: true })")
    expect(await result(view, 'background')).toBe('ERR:AbortError')
    expect(await waitFor(async () => (await shares(app)).length === 0)).toBe(true)

    // A tab that is showing can: the picker is open on the page while the person looks at the other tab.
    await useChooser(app, { kind: 'tab', url: origins.b, delayMs: 1500 })
    await run(view, "window.share('tab', { video: true })")
    await delay(500)
    await chrome.click(`.tab[data-id="${second}"]`)
    expect(await result(view, 'tab', 30_000)).toMatchObject({ tracks: 1, state: 'live', surface: 'browser', label: 'share-b' })
    const [tabShare] = await shares(app)
    expect(tabShare).toMatchObject({ kind: 'tab', label: 'share-b', origin: origins.a })
    await chrome.click(`.tab[data-id="${first as string}"]`)

    // The page stops its own track: the preload reports it and the registry empties.
    await view.evaluate(() => { (window as unknown as { __stream: MediaStream }).__stream.getVideoTracks()[0]?.stop() })
    expect(await waitFor(async () => (await shares(app)).length === 0, 10_000)).toBe(true)

    // The site's block: refused with the picker never asked, and the query says denied.
    const asked = await chooserCalls(app)
    await setSetting(app, 'sites.screenShare', 'block')
    try {
      expect(await view.evaluate(async () => (await navigator.permissions.query({ name: 'display-capture' as PermissionName })).state)).toBe('denied')
      await run(view, "window.share('blocked', { video: true })")
      expect(await result(view, 'blocked')).toBe('ERR:NotAllowedError')
      expect(await chooserCalls(app)).toBe(asked)
    } finally {
      await setSetting(app, 'sites.screenShare', 'ask')
    }
    await delay(200)
    expect(await view.evaluate(async () => (await navigator.permissions.query({ name: 'display-capture' as PermissionName })).state)).toBe('granted')
    expect(mainOutput(app)).not.toMatch(/reached no display handler/)
    await resetChooser(app)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('shares a screen twenty times in a row, each stopped before the next, and the page\'s own request never overtakes the preload\'s arm message', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser?: unknown }).__orivonDevDisplayChooser)) !== undefined)).toBe(true)
    await useChooser(app, { kind: 'screen' })
    const outcomes: string[] = []
    for (let index = 0; index < 20; index++) {
      await run(view, `window.__r = {}; window.share('round', { video: true })`)
      const outcome = await result(view, 'round', 30_000)
      const live = typeof outcome === 'object' && outcome !== null && (outcome as { state?: string }).state === 'live'
      outcomes.push(live ? 'ok' : JSON.stringify(outcome))
      const [running] = await shares(app)
      if (running !== undefined) await stopShare(app, running.id)
      expect(await waitFor(async () => (await shares(app)).length === 0, 10_000)).toBe(true)
    }
    console.log(`screen shares: ${String(outcomes.filter((outcome) => outcome === 'ok').length)} of 20 started`)
    expect(outcomes.filter((outcome) => outcome !== 'ok')).toEqual([])
    expect(mainOutput(app)).not.toMatch(/reached no display handler/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

const liveTracks = async (view: Page): Promise<number> => await view.evaluate(() => (window as unknown as { live: () => number }).live())

it('refuses the preload\'s call when the page made a request of its own first, whether it went around the wrapper before or during the pick', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser?: unknown }).__orivonDevDisplayChooser)) !== undefined)).toBe(true)
    await useChooser(app, { kind: 'screen' })

    // A native call through a realm the preload did not wrap, then the wrapped call right after: the picker is never shown.
    await run(view, "window.native('native'); window.share('wrapped', { video: true })")
    expect(await result(view, 'native')).toBe('ERR:NotAllowedError')
    expect(await result(view, 'wrapped')).toBe('ERR:NotAllowedError')
    expect(await chooserCalls(app)).toBe(0)
    expect(await liveTracks(view)).toBe(0)
    expect(await shares(app)).toEqual([])

    // The same while the picker is open: the picker was shown for the wrapped call, and nothing is shared after it.
    await delay(SUSPECT_MS + 500)
    await useChooser(app, { kind: 'screen', delayMs: 1500 })
    await run(view, "window.__r = {}; window.share('wrapped', { video: true }); setTimeout(() => window.native('native'), 300)")
    expect(await result(view, 'native')).toBe('ERR:NotAllowedError')
    expect(await result(view, 'wrapped', 30_000)).toBe('ERR:NotAllowedError')
    expect(await liveTracks(view)).toBe(0)
    expect(await shares(app)).toEqual([])

    // A legacy desktop call, then the wrapped call: the same.
    await delay(SUSPECT_MS + 500)
    await resetChooser(app)
    await useChooser(app, { kind: 'screen' })
    await run(view, "window.__r = {}; window.legacy('legacy', { mandatory: { chromeMediaSource: 'desktop' } }); window.share('wrapped', { video: true })")
    expect(await result(view, 'legacy')).toBe('ERR:NotAllowedError')
    expect(await result(view, 'wrapped')).toBe('ERR:NotAllowedError')
    expect(await chooserCalls(app)).toBe(0)
    expect(await liveTracks(view)).toBe(0)
    expect(await shares(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('shares honestly once the suspicion that follows a request with no ticket has lapsed', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser?: unknown }).__orivonDevDisplayChooser)) !== undefined)).toBe(true)
    await useChooser(app, { kind: 'screen' })
    await run(view, "window.native('native')")
    expect(await result(view, 'native')).toBe('ERR:NotAllowedError')
    await delay(SUSPECT_MS + 500)
    await run(view, "window.share('honest', { video: true })")
    expect(await result(view, 'honest')).toMatchObject({ tracks: 1, state: 'live' })
    expect(await shares(app)).toHaveLength(1)
    expect(await liveTracks(view)).toBe(1)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('ends the page\'s renderer and its share when a request with no ticket follows the one that was served', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser?: unknown }).__orivonDevDisplayChooser)) !== undefined)).toBe(true)
    await useChooser(app, { kind: 'screen' })
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((each) => !each.isDestroyed() && each.getURL().includes(url))
      ;(globalThis as unknown as { __gone: string[] }).__gone = []
      contents?.on('render-process-gone', (_event, details) => { (globalThis as unknown as { __gone: string[] }).__gone.push(details.reason) })
    }, origins.a)
    await run(view, "window.share('screen', { video: true })")
    expect(await result(view, 'screen')).toMatchObject({ state: 'live' })
    expect(await shares(app)).toHaveLength(1)

    // The page's own request right after: the one served may not have been the preload's.
    await run(view, "window.native('native')").catch(() => undefined)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __gone: string[] }).__gone.length)) > 0, 20_000)).toBe(true)
    expect(await waitFor(async () => (await shares(app)).length === 0, 10_000)).toBe(true)
    expect(mainOutput(app)).toMatch(/request with no ticket followed one that was served/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
