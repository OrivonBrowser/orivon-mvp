// JavaScript, images, sound and automatic downloads, per site and for every site. A site told to block JavaScript
// loads without running a script (a file, an inline handler, a javascript: link, a frame of another site) and
// keeps doing so for a page served from the HTTP cache; images are never requested; a site told to be silent is
// muted at once and its tab says so; a second download a page starts on its own waits for the person's answer.
// The profile is seeded with answers for one site; another site is untouched; the default for every site is
// flipped from Settings while the browser runs. Set ORIVON_UI_SHOTS_DIR to also write screenshots.
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './support/launch-electron.mjs'
import { launchShell, startServer, visit } from './support/qa-helpers.js'
import type { FixtureServer } from './support/qa-helpers.js'
import { clickAddressBarRetrying } from './support/e2e-helpers.js'
import { delay, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 240_000
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const JS_PAGE = `<!doctype html><title>static</title><body><p id="out">static</p>
<button id="inline" onclick="document.title='inline ran'">inline</button>
<a id="jsurl" href="javascript:document.title='js-url ran'">js</a>
<script>document.title = 'script ran'; document.getElementById('out').textContent = 'script ran'</script>`
const FRAME_PAGE = `<!doctype html><body>static frame<script>document.body.textContent = 'frame script ran'</script>`
const TONE_PAGE = `<!doctype html><title>Radio</title><p>tone</p><script>
window.start = async () => { const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.connect(ctx.destination); await ctx.resume(); osc.start(); window.__ctx = ctx; return ctx.state }
</script>`

interface Site extends FixtureServer { hits: Map<string, number> }

async function serve (): Promise<Site> {
  const hits = new Map<string, number>()
  const server = await startServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    const page = (body: string, headers: Record<string, string> = {}): void => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers })
      response.end(body)
    }
    if (url.pathname === '/js') page(JS_PAGE)
    else if (url.pathname === '/js-csp') page(JS_PAGE, { 'content-security-policy': "default-src * 'unsafe-inline'; script-src * 'unsafe-inline'" })
    else if (url.pathname === '/cached') page(JS_PAGE, { 'cache-control': 'max-age=600' })
    else if (url.pathname === '/frame') page(FRAME_PAGE)
    else if (url.pathname === '/outer') page(`<!doctype html><title>outer</title><iframe id="f" src="${url.searchParams.get('src') ?? ''}" style="width:300px;height:60px"></iframe>`)
    else if (url.pathname === '/img') page(`<!doctype html><title>img</title><link rel="icon" href="/fav.png"><img id="a" alt="logo" src="/logo.png"><img id="b" alt="other" src="${url.searchParams.get('other') ?? ''}">`)
    else if (url.pathname.endsWith('.png')) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(PNG) }
    else if (url.pathname === '/tone') page(TONE_PAGE)
    else page('<!doctype html><title>blank</title>')
  })
  return { ...server, hits }
}

let x: Site
let y: Site
let z: Site

beforeAll(async () => {
  x = await serve()
  y = await serve()
  z = await serve()
})

afterAll(async () => {
  for (const site of [x, y, z]) await site.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

/** The answers the profile starts with: every content setting blocked for site `x`. */
const seed = (sites: Record<string, Record<string, string>>, settings: Record<string, unknown> = {}) => async (dir: string): Promise<void> => {
  await writeFile(join(dir, 'site-settings.json'), JSON.stringify({ version: 1, sites }))
  if (Object.keys(settings).length > 0) await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: settings }))
}

async function launchSeeded (sites: Record<string, Record<string, string>>, settings: Record<string, unknown> = {}): Promise<{ app: App, chrome: Page }> {
  return await launchShell({ seedProfile: seed(sites, settings) })
}

/** Flips a default for every site from the Settings page's own bridge, as the person's change would arrive. */
async function setDefault (app: App, chrome: Page, key: string, value: string): Promise<void> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('settings') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('.layout')
  const outcome = await page.evaluate(async ([k, v]) => await (window as unknown as { orivonInternal: { request: (d: string, c: unknown) => Promise<unknown> } }).orivonInternal.request('settings', { type: 'set', key: k, value: v }), [key, value])
  expect(outcome).toMatchObject({ ok: true })
}

const titleOf = async (view: Page): Promise<string> => await view.evaluate(() => document.title)
const textOf = async (view: Page, selector: string): Promise<string> => (await view.locator(selector).textContent()) ?? ''
const frameText = async (view: Page, url: string): Promise<string> => {
  let frame = view.frames().find((f) => f.url() === url)
  await waitFor(() => { frame = view.frames().find((f) => f.url() === url); return frame !== undefined })
  await frame?.waitForLoadState('load')
  return await (frame as NonNullable<typeof frame>).evaluate(() => document.body.childNodes[0]?.textContent ?? '')
}

it('runs no script for a site told to block JavaScript, and runs every other site\'s', async () => {
  const { app, chrome } = await launchSeeded({ [x.origin]: { javascript: 'block' } })
  try {
    // The blocked site: no script file, no inline handler, no javascript: link.
    let view = await visit(app, chrome, `${x.origin}/js`)
    expect(await titleOf(view)).toBe('static')
    expect(await textOf(view, '#out')).toBe('static')
    await view.click('#inline')
    await view.click('#jsurl')
    await delay(300)
    expect(await titleOf(view)).toBe('static')
    // The address bar's key carries the mark while the page in front is on a site with a content block.
    await chrome.waitForSelector('#site-permissions-btn[data-content-blocked]', { state: 'attached' })

    // It adds a policy beside the page's own, never in place of it.
    view = await visit(app, chrome, `${x.origin}/js-csp`)
    expect(await titleOf(view)).toBe('static')

    // Another site is untouched, and a frame follows the page it sits in, in both directions.
    view = await visit(app, chrome, `${y.origin}/js`)
    expect(await titleOf(view)).toBe('script ran')
    await chrome.waitForSelector('#site-permissions-btn:not([data-content-blocked])', { state: 'attached' })
    view = await visit(app, chrome, `${y.origin}/outer?src=${encodeURIComponent(`${x.origin}/frame`)}`)
    expect(await frameText(view, `${x.origin}/frame`)).toBe('frame script ran')
    view = await visit(app, chrome, `${x.origin}/outer?src=${encodeURIComponent(`${y.origin}/frame`)}`)
    expect(await frameText(view, `${y.origin}/frame`)).toBe('static frame')

    // A page served from the HTTP cache is blocked as well: the server saw it once.
    await visit(app, chrome, `${x.origin}/cached`)
    await visit(app, chrome, `${x.origin}/js`)
    view = await visit(app, chrome, `${x.origin}/cached`)
    expect(await titleOf(view)).toBe('static')
    expect(x.hits.get('/cached')).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

/** Closes a tab, so the next load of its address is the only page at it. */
async function closeTab (chrome: Page, id: string): Promise<void> {
  await chrome.hover(`.tab[data-id="${id}"]`)
  await chrome.click(`.tab[data-id="${id}"] .close`)
  expect(await waitFor(async () => !(await tabIds(chrome)).includes(id))).toBe(true)
}

it('follows the default for every site as it is changed, on the next load, including a cached page', async () => {
  const { app, chrome } = await launchSeeded({})
  try {
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
    const first = (await tabIds(chrome))[0] as string
    let view = await visit(app, chrome, `${z.origin}/cached`)
    expect(await titleOf(view)).toBe('script ran')

    // Settings opens in a tab of its own, which then becomes the page's tab.
    await setDefault(app, chrome, 'sites.javascript', 'block')
    await closeTab(chrome, first)
    view = await visit(app, chrome, `${z.origin}/js`)
    expect(await titleOf(view)).toBe('static')
    const second = (await tabIds(chrome))[0] as string
    await setDefault(app, chrome, 'sites.javascript', 'allow')
    await closeTab(chrome, second)
    view = await visit(app, chrome, `${z.origin}/js?again`)
    expect(await titleOf(view)).toBe('script ran')

    // The cached copy of a page follows the setting too: the server saw it once.
    const third = (await tabIds(chrome))[0] as string
    await setDefault(app, chrome, 'sites.javascript', 'block')
    await closeTab(chrome, third)
    view = await visit(app, chrome, `${z.origin}/cached`)
    expect(await titleOf(view)).toBe('static')
    expect(z.hits.get('/cached')).toBe(1)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('never requests an image for a site told to block images, and shows the alternative text', async () => {
  const { app, chrome } = await launchSeeded({ [x.origin]: { images: 'block' } })
  try {
    const other = encodeURIComponent(`${y.origin}/other.png`)
    let view = await visit(app, chrome, `${x.origin}/img?other=${other}`)
    await delay(800)
    expect(x.hits.get('/logo.png')).toBeUndefined()
    expect(y.hits.get('/other.png')).toBeUndefined()
    expect(await view.evaluate(() => Array.from(document.images).map((img) => [img.complete, img.naturalWidth, img.alt]))).toEqual([[true, 0, 'logo'], [true, 0, 'other']])
    console.log(`[probe] favicon requests while images are blocked: ${String(x.hits.get('/fav.png') ?? 0)}`)

    // Another site loads its images.
    view = await visit(app, chrome, `${y.origin}/img?other=${other}`)
    expect(await waitFor(() => y.hits.get('/logo.png') === 1 && y.hits.get('/other.png') === 1)).toBe(true)
    expect(await view.evaluate(() => Array.from(document.images).map((img) => img.naturalWidth))).toEqual([1, 1])

    // The default for every site, flipped while running, takes effect on the next load.
    await setDefault(app, chrome, 'sites.images', 'block')
    await visit(app, chrome, `${z.origin}/img?other=${other}`)
    await delay(800)
    expect(z.hits.get('/logo.png')).toBeUndefined()
    await setDefault(app, chrome, 'sites.images', 'allow')
    await visit(app, chrome, `${z.origin}/img?second`)
    expect(await waitFor(() => z.hits.get('/logo.png') === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

const wcMuted = async (app: App, url: string): Promise<boolean | undefined> => await app.evaluate(({ webContents }, address) => webContents.getAllWebContents().find((w) => w.getURL() === address)?.isAudioMuted(), url)
const startTone = async (app: App, url: string): Promise<unknown> => await app.evaluate(async ({ webContents }, address) => await webContents.getAllWebContents().find((w) => w.getURL() === address)?.executeJavaScript('window.start()', true), url)
const act = async (chrome: Page, name: string, payload: unknown): Promise<void> => {
  await chrome.evaluate(([n, p]) => { void (window as unknown as { orivonShell: { act: (n: string, p: unknown) => Promise<unknown> } }).orivonShell.act(n as string, p) }, [name, payload])
}

async function newTabAt (chrome: Page, url: string): Promise<string> {
  await chrome.click('#new-tab')
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
  return (await tabIds(chrome)).at(-1) as string
}

async function shootStrip (chrome: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: theme })
    await chrome.mouse.move(700, 60)
    await waitFor(async () => await chrome.evaluate((t) => matchMedia('(prefers-color-scheme: dark)').matches === (t === 'dark'), theme))
    await delay(250)
    await chrome.screenshot({ path: join(SHOTS_DIR, `${name}-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 76 } })
  }
  await chrome.emulateMedia({ colorScheme: null })
}

it('silences a site told to be silent at once, says so on its tab, and never lets the tab\'s own mute override it', async () => {
  const { app, chrome } = await launchSeeded({ [x.origin]: { sound: 'block' } })
  try {
    const quiet = await newTabAt(chrome, `${x.origin}/tone`)
    const loud = await newTabAt(chrome, `${y.origin}/tone`)
    expect(await startTone(app, `${x.origin}/tone`)).toBe('running')
    expect(await startTone(app, `${y.origin}/tone`)).toBe('running')

    expect(await waitFor(async () => (await wcMuted(app, `${x.origin}/tone`)) === true)).toBe(true)
    expect(await wcMuted(app, `${y.origin}/tone`)).toBe(false)
    const badge = (id: string) => chrome.locator(`.tab[data-id="${id}"] .tab-audio`)
    expect(await waitFor(async () => (await badge(quiet).count()) === 1 && (await badge(loud).count()) === 1)).toBe(true)
    expect(await badge(quiet).getAttribute('aria-label')).toBe('Muted by site settings')
    expect(await badge(quiet).getAttribute('aria-disabled')).toBe('true')
    expect(await chrome.locator(`.tab[data-id="${quiet}"]`).getAttribute('title')).toContain('(muted by site settings)')
    expect(await badge(loud).getAttribute('aria-label')).toBe('Mute tab')
    await shootStrip(chrome, 'tab-site-muted')

    // The tab's own mute changes only the tab's own: the site's stays, whatever is done to the tab.
    await act(chrome, 'tab.mute', { id: quiet })
    await act(chrome, 'tab.mute', { id: quiet })
    await delay(400)
    expect(await wcMuted(app, `${x.origin}/tone`)).toBe(true)
    await badge(quiet).dispatchEvent('click')
    await delay(300)
    expect(await badge(quiet).getAttribute('aria-label')).toBe('Muted by site settings')
    await act(chrome, 'tab.mute', { id: loud })
    expect(await waitFor(async () => (await wcMuted(app, `${y.origin}/tone`)) === true)).toBe(true)
    await act(chrome, 'tab.mute', { id: loud })
    expect(await waitFor(async () => (await wcMuted(app, `${y.origin}/tone`)) === false)).toBe(true)

    // The default for every site, flipped while running, silences the other tab with no reload, and back.
    await setDefault(app, chrome, 'sites.sound', 'block')
    expect(await waitFor(async () => (await wcMuted(app, `${y.origin}/tone`)) === true)).toBe(true)
    await setDefault(app, chrome, 'sites.sound', 'allow')
    expect(await waitFor(async () => (await wcMuted(app, `${y.origin}/tone`)) === false)).toBe(true)
    expect(await wcMuted(app, `${x.origin}/tone`)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
