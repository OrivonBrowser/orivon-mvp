// Screen sharing as the person meets it (ADR-0055), through the real picker: the page calls `getDisplayMedia`, the
// picker opens in the window, the person chooses, the tab, the chip and the bar say so, and Stop in the bar ends the
// page's track. The gate's own rules are proved with a stand-in picker in e2e-screen-share-gate.test.ts. The Window
// segment is not asserted: the virtual display has no window manager, so it lists no windows.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const E2E_TIMEOUT_MS = 240_000

const PAGE = (name: string, extra = ''): string => `<!doctype html><title>${name}</title><body><button id="go">go</button>
<script>
window.__r = {}
const done = (key, promise) => promise.then((value) => { window.__r[key] = value }, (error) => { window.__r[key] = 'ERR:' + error.name })
const describe = (stream) => { const track = stream.getVideoTracks()[0]; return { tracks: stream.getTracks().length, state: track.readyState, surface: track.getSettings().displaySurface, label: track.label } }
window.share = (key, options) => done(key, navigator.mediaDevices.getDisplayMedia(options).then((stream) => {
  window.__stream = stream
  stream.getVideoTracks()[0].addEventListener('ended', () => { window.__r.ended = (window.__r.ended || 0) + 1 })
  return describe(stream)
}))
window.startCount = () => {
  const reader = new MediaStreamTrackProcessor({ track: window.__stream.getVideoTracks()[0] }).readable.getReader()
  window.__n = 0
  ;(async () => { for (;;) { const { value, done: finished } = await reader.read(); if (finished) break; window.__n++; value.close() } })()
}
window.__next = () => {}
document.getElementById('go').addEventListener('click', () => window.__next())
${extra}
</script></body>`

/** A page whose paint never stops, so a capture of it keeps delivering frames. */
const ANIMATED = "let hue = 0; setInterval(() => { document.body.style.background = 'hsl(' + ((hue += 9) % 360) + ' 80% 50%)' }, 33)"

const servers: FixtureServer[] = []
const origins = { a: '', b: '', c: '' }

beforeAll(async () => {
  for (const [key, name, extra] of [['a', 'share-a', ''], ['b', 'share-b', ANIMATED], ['c', 'share-c', '']] as const) {
    const server = await startServer((_request, response) => { html(response, PAGE(name, extra)) })
    servers.push(server)
    origins[key] = server.origin
  }
})

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const overlayPage = (app: App, name: string): Page | undefined => app.windows().find((page) => page.url().includes(`overlay=${name}`) && !page.isClosed())
const waitOverlay = async (app: App, name: string, selector: string): Promise<Page> => {
  let found: Page | undefined
  expect(await waitFor(async () => {
    const page = overlayPage(app, name)
    if (page === undefined) return false
    try { await page.waitForSelector(selector, { timeout: 1_000 }); found = page; return true } catch { return false }
  }, 20_000)).toBe(true)
  return found as Page
}
const overlayGone = async (app: App, name: string): Promise<boolean> => await waitFor(() => overlayPage(app, name) === undefined, 10_000)

const result = async (view: Page, key: string, timeoutMs = 15_000): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key); return last !== undefined }, timeoutMs)
  return last
}
const run = async (view: Page, body: string): Promise<void> => {
  await view.evaluate((code) => { (window as unknown as { __next: () => void }).__next = new Function(code) as () => void }, body)
  await view.click('#go')
}

/** Waits for Share to be allowed (a card chosen and the guard past), then presses it as the person does. */
async function pressShare (picker: Page): Promise<void> {
  expect(await waitFor(async () => await picker.evaluate(() => !document.querySelector('.picker')?.classList.contains('arming') && !(document.querySelector('.btn-row .btn.primary') as HTMLButtonElement).disabled), 10_000)).toBe(true)
  await picker.click('.btn-row .btn.primary')
}
/** Escape closes the page it is pressed in, so the key's release finds no page: that error is the effect. */
const escape = async (picker: Page): Promise<void> => { await picker.keyboard.press('Escape').catch(() => {}) }
const segmentsOf = async (picker: Page): Promise<string[]> => await picker.locator('.picker-segments button').allTextContents()
const cardLabels = async (picker: Page): Promise<string[]> => await picker.locator('.picker-card .picker-label').allTextContents()
const activeSegment = async (picker: Page): Promise<string | null> => await picker.locator('.picker-segments button[aria-selected="true"]').textContent()

async function chipLabel (chrome: Page): Promise<string | null> {
  return await chrome.evaluate(() => { const chip = document.querySelector('#sharing-chip') as HTMLElement | null; return chip === null || chip.hidden ? null : chip.getAttribute('aria-label') })
}
const tabMark = async (chrome: Page, id: string): Promise<string | null> =>
  await chrome.evaluate((tabId) => document.querySelector(`.tab[data-id="${tabId}"] .tab-share`)?.getAttribute('aria-label') ?? null, id)

const SHARING_BAR = 'sharing-bar'

it('opens its picker on the page\'s hints, shares an entire screen, shows who shares in the tab, the address bar and a bar, and Stop in the bar ends the track', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    const [first] = await tabIds(chrome) as string[]
    expect(await waitFor(async () => (await chipLabel(chrome)) === null)).toBe(true)

    // Escape: the page is refused, the picker is gone. It named the site and offers the three segments, opening on tabs.
    await run(view, "window.share('esc', { video: true })")
    let picker = await waitOverlay(app, 'screen-share-picker', '.picker-card')
    expect(await picker.textContent('.sheet-title')).toContain('Choose what to share with')
    expect(await segmentsOf(picker)).toEqual(['Tab', 'Window', 'Entire screen'])
    expect(await activeSegment(picker)).toBe('Tab')
    expect(await picker.getAttribute('.picker', 'role')).toBe('dialog')
    expect(await picker.evaluate(() => (document.querySelector('.btn-row .btn.primary') as HTMLButtonElement).disabled)).toBe(true)
    await escape(picker)
    expect(await result(view, 'esc')).toBe('ERR:NotAllowedError')
    expect(await overlayGone(app, 'screen-share-picker')).toBe(true)

    // Cancel does the same.
    await run(view, "window.share('cancel', { video: true })")
    picker = await waitOverlay(app, 'screen-share-picker', '.picker-card')
    await picker.click('.btn-row .btn:not(.primary)')
    expect(await result(view, 'cancel')).toBe('ERR:NotAllowedError')
    expect(await overlayGone(app, 'screen-share-picker')).toBe(true)

    // A page that prefers this tab: opens on Tab with "This tab" first and chosen.
    await run(view, "window.share('pref', { video: true, preferCurrentTab: true })")
    picker = await waitOverlay(app, 'screen-share-picker', '.picker-card')
    expect(await activeSegment(picker)).toBe('Tab')
    expect(await picker.locator('.picker-card').first().locator('.picker-self').textContent()).toBe('This tab')
    expect(await picker.locator('.picker-card').first().getAttribute('aria-selected')).toBe('true')
    // A page that names the screen opens on it, and one that wants no screens loses the segment.
    await escape(picker)
    expect(await result(view, 'pref')).toBe('ERR:NotAllowedError')
    await run(view, "window.share('noscreen', { video: { displaySurface: 'monitor' }, monitorTypeSurfaces: 'exclude' })")
    picker = await waitOverlay(app, 'screen-share-picker', '.picker-segments')
    expect(await segmentsOf(picker)).toEqual(['Tab', 'Window'])
    await escape(picker)
    expect(await result(view, 'noscreen')).toBe('ERR:NotAllowedError')

    // The entire screen: chosen in the picker, shared as a monitor.
    await run(view, "window.share('screen', { video: { displaySurface: 'monitor' } })")
    picker = await waitOverlay(app, 'screen-share-picker', '.picker-segments')
    expect(await activeSegment(picker)).toBe('Entire screen')
    await picker.waitForSelector('.picker-card')
    expect((await cardLabels(picker)).length).toBe(1)
    await picker.click('.picker-card')
    await pressShare(picker)
    expect(await result(view, 'screen', 30_000)).toMatchObject({ tracks: 1, state: 'live', surface: 'monitor' })
    expect(await overlayGone(app, 'screen-share-picker')).toBe(true)

    // The tab, the address bar and the bar say so.
    expect(await waitFor(async () => (await tabMark(chrome, first as string)) === 'Sharing your screen')).toBe(true)
    expect(await waitFor(async () => (await chipLabel(chrome))?.startsWith('Sharing your screen with ') === true)).toBe(true)
    const bar = await waitOverlay(app, SHARING_BAR, '.sharing-text')
    expect(await bar.textContent('.sharing-text')).toMatch(/ is sharing your screen$/)

    // Hide takes the bar away; the chip brings it back.
    await bar.click('button[aria-label="Hide this bar"]')
    expect(await overlayGone(app, SHARING_BAR)).toBe(true)
    await chrome.click('#sharing-chip')
    const again = await waitOverlay(app, SHARING_BAR, '.sharing-text')

    // Stop sharing: the page's track ends and its listener ran; every indicator goes.
    await again.click('text=Stop sharing')
    expect(await result(view, 'ended')).toBe(1)
    expect(await view.evaluate(() => (window as unknown as { __stream: MediaStream }).__stream.getVideoTracks()[0]?.readyState)).toBe('ended')
    expect(await overlayGone(app, SHARING_BAR)).toBe(true)
    expect(await waitFor(async () => (await chipLabel(chrome)) === null)).toBe(true)
    expect(await waitFor(async () => (await tabMark(chrome, first as string)) === null)).toBe(true)

    // A site set to Block in site info is refused with no picker, and the row offers Ask and Block only.
    await chrome.click('#site-permissions-btn')
    expect(await waitFor(() => app.windows().some((page) => page.url().includes('/site-info/') && !page.isClosed()))).toBe(true)
    const info = app.windows().find((page) => page.url().includes('/site-info/') && !page.isClosed()) as Page
    await info.waitForSelector('.permissions')
    await info.click('.add-permission')
    await info.waitForSelector('.more-list')
    expect(await info.locator('.perm-select[data-kind="screenShare"] option').allTextContents()).toEqual(['Use default (Ask)', 'Block'])
    await info.selectOption('.perm-select[data-kind="screenShare"]', 'block')
    await chrome.click('#site-permissions-btn')
    await run(view, "window.share('blocked', { video: true })")
    expect(await result(view, 'blocked')).toBe('ERR:NotAllowedError')
    await delay(1_200)
    expect(overlayPage(app, 'screen-share-picker')).toBeUndefined()

    expect(mainOutput(app)).not.toMatch(/reached no display handler/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('shares another tab: it comes to the front, keeps painting for the page while the person is on a third tab, and is let go when Stop is pressed', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    const [first] = await tabIds(chrome) as string[]
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origins.b}/`)
    expect((await waitForTab(chrome, { address: `${origins.b}/` })).ok).toBe(true)
    const second = (await tabIds(chrome)).at(-1) as string
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origins.c}/`)
    expect((await waitForTab(chrome, { address: `${origins.c}/` })).ok).toBe(true)
    const third = (await tabIds(chrome)).at(-1) as string
    await chrome.click(`.tab[data-id="${first as string}"]`)
    expect(await waitFor(() => findViewShowing(app, chrome, `${origins.a}/`) !== undefined)).toBe(true)

    // The tabs of the window, with this tab first.
    await run(view, "window.share('tab', { video: true })")
    const picker = await waitOverlay(app, 'screen-share-picker', '.picker-card')
    expect(await cardLabels(picker)).toEqual(['share-a', 'share-b', 'share-c'])
    expect(await picker.locator('.picker-card').first().locator('.picker-self').textContent()).toBe('This tab')
    // The arrow keys move the choice in the grid.
    await picker.locator('.picker-card', { hasText: 'share-c' }).click()
    await picker.locator('.picker-grid').focus()
    await picker.keyboard.press('ArrowLeft')
    expect(await picker.locator('.picker-card[aria-selected="true"] .picker-label').allTextContents()).toEqual(['share-b'])
    await pressShare(picker)
    expect(await result(view, 'tab', 30_000)).toMatchObject({ tracks: 1, state: 'live', surface: 'browser', label: 'share-b' })

    // The tab picked came to the front, and both tabs carry the marks.
    expect(await waitFor(async () => await chrome.evaluate((id) => document.querySelector(`.tab[data-id="${id}"]`)?.classList.contains('active') === true, second))).toBe(true)
    expect(await tabMark(chrome, first as string)).toBe('Sharing a tab')
    expect(await waitFor(async () => (await tabMark(chrome, second)) === 'This tab is being shared')).toBe(true)

    // The person goes to a third tab: the shared tab's view stays in the window, hidden, and its frames keep arriving.
    // Frames are counted in the page that receives them with a MediaStreamTrackProcessor reader, which runs in a background tab.
    await view.evaluate(() => { (window as unknown as { startCount: () => void }).startCount() })
    await chrome.click(`.tab[data-id="${third}"]`)
    const sharedViewAttached = async (): Promise<boolean | undefined> => await app.evaluate(({ BaseWindow, webContents }, url) => {
      const shared = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(url))
      const window = BaseWindow.getAllWindows().find((candidate) => candidate.contentView.children.length > 0)
      const view = window?.contentView.children.find((child) => (child as unknown as { webContents?: unknown }).webContents === shared)
      return view === undefined ? undefined : view.getVisible()
    }, origins.b)
    expect(await sharedViewAttached()).toBe(false)
    // Its page reads visible while it is shared and behind another tab, as a captured tab does in Chrome.
    const sharedPageState = async (): Promise<string> => await app.evaluate(async ({ webContents }, url) => {
      const shared = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(url))
      return shared === undefined ? 'missing' : String(await shared.executeJavaScript('document.visibilityState'))
    }, origins.b)
    expect(await waitFor(async () => (await sharedPageState()) === 'visible')).toBe(true)
    const count = async (): Promise<number> => await view.evaluate(() => (window as unknown as { __n: number }).__n)
    await delay(500)
    const before = await count()
    await delay(2_000)
    const after = await count()
    console.log(`frames reaching the page from the shared tab while another tab is in front: ${String(after - before)} in 2 s (${String(before)} before)`)
    expect(after - before).toBeGreaterThan(20)

    // Stop in the bar: the track ends and the shared tab is let go of by the window.
    const bar = await waitOverlay(app, SHARING_BAR, '.sharing-text')
    expect(await bar.textContent('.sharing-text')).toMatch(/ is sharing a tab$/)
    await bar.click('text=Stop sharing')
    expect(await result(view, 'ended')).toBe(1)
    expect(await waitFor(async () => (await sharedViewAttached()) === undefined)).toBe(true)
    expect(await waitFor(async () => (await tabMark(chrome, second)) === null)).toBe(true)
    // The share is over and the tab is still behind another: its page reads hidden again.
    expect(await waitFor(async () => (await sharedPageState()) === 'hidden')).toBe(true)
    expect(mainOutput(app)).not.toMatch(/reached no display handler/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
