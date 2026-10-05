// A tab that is out of the person's sight reads as hidden to its page, as in Chrome: behind another tab, opened
// in the background, or in a window that is hidden. The page records what it reads and every visibilitychange.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const SILENT = { args: [HERMETIC_RESOLVER, '--alsa-output-device=null'], env: { PULSE_SERVER: 'unix:/nonexistent' } }

let server: Server
let origin = ''

const PAGE = (name: string): string => `<!doctype html><title>page ${name}</title>
<a id="link" href="/c">open c</a>
<script>
  window.recorded = { atStart: document.visibilityState, changes: [] }
  document.addEventListener('visibilitychange', (event) => {
    window.recorded.changes.push({ state: document.visibilityState, hidden: document.hidden, bubbles: event.bubbles })
  })
</script>`

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(PAGE((request.url ?? '/').slice(1)))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Recorded { atStart: string, changes: Array<{ state: string, hidden: boolean, bubbles: boolean }> }
interface Seen { state: string, hidden: boolean, webkitState: string, webkitHidden: boolean, recorded: Recorded }

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const strip = async (chrome: Page): Promise<Array<{ id: string, title: string }>> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('.tab')).map((el) => ({ id: el.dataset['id'] ?? '', title: el.querySelector('.title')?.textContent ?? '' })))

async function openTab (chrome: Page, name: string): Promise<void> {
  await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, `${origin}/${name}`)
  expect(await waitFor(async () => (await strip(chrome)).some((tab) => tab.title === `page ${name}`))).toBe(true)
}

async function bringForward (chrome: Page, name: string): Promise<void> {
  const tab = (await strip(chrome)).find((candidate) => candidate.title === `page ${name}`)
  expect(tab, name).toBeDefined()
  await chrome.evaluate((id) => { (window as unknown as { orivonShell: { activateTab: (i: string) => void } }).orivonShell.activateTab(id) }, tab?.id ?? '')
}

const viewOf = (app: ElectronApplication, chrome: Page, name: string): Page => {
  const view = findViewShowing(app, chrome, `${origin}/${name}`) as Page | undefined
  if (view === undefined) throw new Error(`no view showing ${name}`)
  return view
}

async function read (view: Page): Promise<Seen> {
  return await evaluateRetrying(view, () => ({
    state: document.visibilityState,
    hidden: document.hidden,
    webkitState: (document as unknown as { webkitVisibilityState: string }).webkitVisibilityState,
    webkitHidden: (document as unknown as { webkitHidden: boolean }).webkitHidden,
    recorded: (window as unknown as { recorded: Recorded }).recorded
  }))
}

/** Waits for the page to read `state`, then reads once. */
async function settledAs (view: Page, state: string): Promise<Seen> {
  let seen = await read(view)
  await waitFor(async () => { seen = await read(view); return seen.state === state })
  return seen
}

it('reads hidden behind another tab with one event, and visible again with a second', async () => {
  const { app, chrome } = await launched()
  try {
    await openTab(chrome, 'a')
    const a = viewOf(app, chrome, 'a')
    expect((await settledAs(a, 'visible')).recorded.changes).toEqual([])

    await openTab(chrome, 'b')
    const hidden = await settledAs(a, 'hidden')
    expect(hidden).toMatchObject({ state: 'hidden', hidden: true, webkitState: 'hidden', webkitHidden: true })
    expect(hidden.recorded.changes).toEqual([{ state: 'hidden', hidden: true, bubbles: true }])
    expect(await read(viewOf(app, chrome, 'b'))).toMatchObject({ state: 'visible', hidden: false })

    await bringForward(chrome, 'a')
    const back = await settledAs(a, 'visible')
    expect(back).toMatchObject({ hidden: false, webkitState: 'visible', webkitHidden: false })
    expect(back.recorded.changes).toEqual([{ state: 'hidden', hidden: true, bubbles: true }, { state: 'visible', hidden: false, bubbles: true }])
    expect((await settledAs(viewOf(app, chrome, 'b'), 'hidden')).recorded.changes).toHaveLength(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('reads hidden in a page opened in the background, once it has loaded', async () => {
  const { app, chrome } = await launched()
  try {
    await openTab(chrome, 'a')
    const a = viewOf(app, chrome, 'a')
    await a.click('#link', { modifiers: ['Control'] })
    expect(await waitFor(async () => (await strip(chrome)).some((tab) => tab.title === 'page c'))).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, `${origin}/c`) !== undefined)).toBe(true)
    const c = await settledAs(viewOf(app, chrome, 'c'), 'hidden')
    expect(c).toMatchObject({ state: 'hidden', hidden: true })
    // The page in front was never told anything.
    expect((await read(a)).recorded.changes).toEqual([])
    expect(await read(a)).toMatchObject({ state: 'visible' })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('reads hidden in every tab of a window that is hidden, and visible when it is shown', async () => {
  const { app, chrome } = await launched()
  try {
    await openTab(chrome, 'a')
    const a = viewOf(app, chrome, 'a')
    await settledAs(a, 'visible')
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows().forEach((win) => { win.hide() }) })
    expect((await settledAs(a, 'hidden')).hidden).toBe(true)
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows().forEach((win) => { win.show() }) })
    const shown = await settledAs(a, 'visible')
    expect(shown.recorded.changes.map((change) => change.state)).toEqual(['hidden', 'visible'])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
