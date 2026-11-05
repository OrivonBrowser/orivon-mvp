// A website whose page asks for a WebGPU adapter is asked under the address bar, "wants to use your graphics card
// for WebGPU", with Block and Grant WebGPU, and the answer is kept per site. CI runs this on an X11 session with no
// graphics card behind it: Chromium gives no adapter there, so the question is the one that turns the graphics mode on
// and offers a restart. That path is what the spec drives: the question, the grant (the setting turned on, the allow
// kept, the page told it has no adapter, the offer to start again), the block, an origin that holds grants, which
// is not asked, and a private window, which is not asked to restart. Restart Orivon is never pressed. The path with an adapter to give is run by
// test/page/e2e-webgpu-x11.test.ts on a computer that has a card. Set ORIVON_UI_SHOTS_DIR to also write screenshots.
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Manifest } from '../../src/contracts/index.js'
import { serveApp } from '../node-runtime/pinned-app.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { nativeDialogsAsked as dialogsAsked, stubNativeDialogs as stubDialogs } from '../support/question-support.js'
import { activeTabInfo, delay, findViewShowing, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 180_000
const SETTING = 'graphics.webgpuOnX11'
const BARE_APP = 'https://webgpu-asked-bare-e2e.orivon.test'
const GRANTED_APP = 'https://webgpu-asked-granted-e2e.orivon.test'

const SCRIPT = `window.__r = {}
document.getElementById('gpu').addEventListener('click', () => {
  navigator.gpu.requestAdapter().then((adapter) => { window.__r.gpu = adapter === null ? 'null' : 'adapter' }, (error) => { window.__r.gpu = 'ERR:' + error.name })
})`
const PAGE = `<!doctype html><title>webgpu</title><body style="font:16px sans-serif"><button id="gpu">gpu</button><script>${SCRIPT}</script></body>`
const APP_PAGE = '<!doctype html><title>webgpu app</title><body><button id="gpu">gpu</button><script src="/app.js"></script></body>'

const servers: FixtureServer[] = []
const origins = { a: '', b: '' }

beforeAll(async () => {
  for (const key of ['a', 'b'] as const) {
    const server = await startServer((_request, response) => { html(response, PAGE) })
    servers.push(server)
    origins[key] = server.origin
  }
})

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const promptPages = (app: App): Page[] => app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed())
const promptShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=site-prompt')

/** The newest prompt page that is on screen and has drawn `selector`: a closed overlay's page stays listed for a moment, so one that dies under the wait is skipped. */
async function waitPrompt (app: App, selector: string): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    if (!(await promptShown(app))) return false
    for (const candidate of promptPages(app).reverse()) {
      try {
        if (await candidate.locator(selector).count() === 0) continue
        await candidate.waitForSelector(selector, { timeout: 2_000 })
        found = candidate
        return true
      } catch {
        // Closed under the wait.
      }
    }
    return false
  }, 15_000)
  expect(ok).toBe(true)
  return found as Page
}

const waitAsk = async (app: App): Promise<Page> => await waitPrompt(app, '.site-prompt .btn-row')
const waitRestartOffer = async (app: App): Promise<Page> => await waitPrompt(app, '.site-prompt .sp-restart')

async function expectNoPrompt (app: App): Promise<void> {
  await delay(1_200)
  expect(await promptShown(app)).toBe(false)
}

/** Waits out the half second the buttons ignore presses, then presses one. The page may already be gone by the time the click settles. */
async function press (page: Page, label: string): Promise<void> {
  await page.waitForSelector('.site-prompt:not(.arming)')
  try { await page.click(`.btn-row .btn:text-is("${label}")`) } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
}

const textOf = async (page: Page, selector: string): Promise<string[]> => await page.locator(selector).allTextContents()
const result = async (view: Page): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await view.evaluate(() => (window as unknown as { __r: Record<string, unknown> }).__r['gpu']); return last !== undefined }, 12_000)
  return last
}
const clear = async (view: Page): Promise<void> => { await view.evaluate(() => { delete (window as unknown as { __r: Record<string, unknown> }).__r['gpu'] }) }

const userDataOf = async (app: App): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

const readJson = (file: string): unknown => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
const settingOf = (dir: string): unknown => (readJson(join(dir, 'settings.json')) as { values?: Record<string, unknown> } | null)?.values?.[SETTING]
const siteAnswers = (dir: string, origin: string): unknown => (readJson(join(dir, 'site-settings.json')) as { sites?: Record<string, unknown> } | null)?.sites?.[origin]

async function shoot (app: App, chrome: Page, name: string, page: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await page.waitForSelector('.site-prompt:not(.arming)')
  for (const scheme of ['light', 'dark'] as const) {
    await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
    for (const target of [chrome, page]) await target.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
  await chrome.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'light' })
}

it('[app:webgpu-asked-per-site] asks a website that wants WebGPU, turns the graphics mode on and offers a restart when it is granted, and keeps a block', async () => {
  const { app, chrome } = await launchShell()
  try {
    await stubDialogs(app)
    const dir = await userDataOf(app)
    expect(settingOf(dir)).not.toBe(true)

    // A site that is blocked: told it has no adapter, and not asked again. The graphics mode stays as it was.
    const second = await visit(app, chrome, `${origins.b}/`)
    expect(await promptShown(app)).toBe(false)
    await second.click('#gpu')
    let prompt = await waitAsk(app)
    expect(await textOf(prompt, '.origin')).toEqual([origins.b])
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to use your graphics card for WebGPU'])
    await press(prompt, 'Block')
    expect(await result(second)).toBe('null')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await clear(second)
    await second.click('#gpu')
    expect(await result(second)).toBe('null')
    await expectNoPrompt(app)
    expect(await waitFor(() => JSON.stringify(siteAnswers(dir, origins.b)) === JSON.stringify({ webgpu: 'block' }))).toBe(true)
    expect(settingOf(dir)).not.toBe(true)

    // A site that is granted: the question says what the restart costs, the grant is kept, the setting turns on, and
    // the offer to start again follows. The page still has no adapter this run.
    const view = await visit(app, chrome, `${origins.a}/`)
    await view.click('#gpu')
    prompt = await waitAsk(app)
    expect(await textOf(prompt, '.origin')).toEqual([origins.a])
    expect(await textOf(prompt, '.sp-text')).toEqual(['wants to use your graphics card for WebGPU'])
    expect(await textOf(prompt, '.sp-note')).toEqual(['Orivon restarts to turn WebGPU on. It may use more battery, and on some laptops videos can go blank.'])
    expect(await textOf(prompt, '.btn-row .btn')).toEqual(['Block', 'Grant WebGPU'])
    expect(await prompt.getAttribute('.site-prompt', 'role')).toBe('dialog')
    await shoot(app, chrome, 'ask-webgpu', prompt)
    await press(prompt, 'Grant WebGPU')

    const offer = await waitRestartOffer(app)
    expect(await textOf(offer, '.sp-restart')).toEqual(['WebGPU starts after Orivon restarts.'])
    expect(await textOf(offer, '.sp-restart-note')).toEqual(['Orivon opens this page again. Your other tabs and windows are not restored.'])
    expect(await textOf(offer, '.btn-row .btn')).toEqual(['Later', 'Restart Orivon'])
    await shoot(app, chrome, 'restart-offer', offer)
    expect(await result(view)).toBe('null')
    expect(await waitFor(() => settingOf(dir) === true)).toBe(true)
    expect(await waitFor(() => JSON.stringify(siteAnswers(dir, origins.a)) === JSON.stringify({ webgpu: 'allow' }))).toBe(true)

    // Later closes the offer and leaves the browser running; a second call is neither asked nor offered anything.
    await offer.waitForSelector('.site-prompt:not(.arming)')
    await offer.click('.btn-row .btn:text-is("Later")')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    await clear(view)
    await view.click('#gpu')
    expect(await result(view)).toBe('null')
    await expectNoPrompt(app)
    expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true)

    expect(await dialogsAsked(app)).toEqual([])
    expect(mainOutput(app)).not.toMatch(/\[site-asks\]|webgpu requestAdapter not wrapped/)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('[app:webgpu-asked-per-site] does not ask an installed app that holds grants for WebGPU, and asks one that holds none as a website', async () => {
  const { app, chrome } = await launchShell()
  try {
    const manifestOf = (id: string, capabilities: Manifest['capabilities']): Manifest => ({ orivonApiVersion: 0, id: `app.orivon.behaviour.${id}`, name: `Behaviour ${id}`, version: '1.0.0', entry: 'index.html', capabilities })
    const files = { '/index.html': new TextEncoder().encode(APP_PAGE), '/app.js': new TextEncoder().encode(SCRIPT) }
    expect(await serveApp(app, BARE_APP, manifestOf('webgpu-asked-bare', {}), null, files)).toEqual({ granted: true, registered: true })
    const connect = ['webgpu-asked.test:9']
    expect(await serveApp(app, GRANTED_APP, manifestOf('webgpu-asked-granted', { net: { tcp: { connect } } }), 'tcp.connect', files, connect)).toEqual({ granted: true, registered: true })

    // The control: an installed app with no grant is a website here, and is asked.
    const bare = await visit(app, chrome, `${BARE_APP}/`)
    await bare.click('#gpu')
    const prompt = await waitAsk(app)
    expect(await textOf(prompt, '.origin')).toEqual([BARE_APP])
    await press(prompt, 'Block')
    expect(await result(bare)).toBe('null')

    const granted = await visit(app, chrome, `${GRANTED_APP}/`)
    await granted.click('#gpu')
    expect(await result(granted)).toBe('null')
    await expectNoPrompt(app)
    expect(settingOf(await userDataOf(app))).not.toBe(true)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('[app:webgpu-asked-per-site] asks nothing in a private window, which cannot start again to turn the graphics mode on', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private'] })
  try {
    const view = await visit(app, chrome, `${origins.a}/`)
    await view.click('#gpu')
    expect(await result(view)).toBe('null')
    await expectNoPrompt(app)
    expect(settingOf(await userDataOf(app))).not.toBe(true)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('[app:webgpu-asked-per-site] says the tabs and windows open again when Orivon continues where it left off, and still never presses Restart Orivon', async () => {
  const continuing = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'startup.mode': 'continue' } }))
  }
  const { app, chrome } = await launchShell({ seedProfile: continuing })
  try {
    const dir = await userDataOf(app)
    const view = await visit(app, chrome, `${origins.a}/`)
    await view.click('#gpu')
    const prompt = await waitAsk(app)
    await press(prompt, 'Grant WebGPU')
    const offer = await waitRestartOffer(app)
    expect(await textOf(offer, '.sp-restart')).toEqual(['WebGPU starts after Orivon restarts.'])
    expect(await textOf(offer, '.sp-restart-note')).toEqual(['Your tabs and windows open again.'])
    expect(await textOf(offer, '.btn-row .btn')).toEqual(['Later', 'Restart Orivon'])
    expect(await waitFor(() => settingOf(dir) === true)).toBe(true)
    await offer.waitForSelector('.site-prompt:not(.arming)')
    await offer.click('.btn-row .btn:text-is("Later")')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('[app:webgpu-asked-per-site] says nothing of this page opening again when its tab carries a tunnel choice of its own, which a launch tab would lose', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${origins.a}/`)
    const tabId = (await activeTabInfo(chrome)).activeId as string
    const kept = await app.evaluate((_electron, id) => (globalThis as unknown as { __orivonDevTabTunnel?: { set: (tab: string, choice: string | null) => boolean } }).__orivonDevTabTunnel?.set(id as string, 'direct'), tabId)
    expect(kept, 'the test seam found the tab').toBe(true)
    // The choice moves the tab to a session of its own, so the page loads again there.
    expect(await waitFor(() => findViewShowing(app, chrome, `${origins.a}/`) !== undefined)).toBe(true)
    const view = findViewShowing(app, chrome, `${origins.a}/`) as Page
    await view.waitForLoadState('load')
    await view.click('#gpu')
    const prompt = await waitAsk(app)
    await press(prompt, 'Grant WebGPU')
    const offer = await waitRestartOffer(app)
    expect(await textOf(offer, '.sp-restart-note')).toEqual(['Your tabs and windows are not restored.'])
    await offer.waitForSelector('.site-prompt:not(.arming)')
    await offer.click('.btn-row .btn:text-is("Later")')
    expect(await waitFor(async () => !(await promptShown(app)))).toBe(true)
    expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
