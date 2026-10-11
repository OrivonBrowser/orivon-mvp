// chrome.bookmarks, history, topSites and search in the running shell. An extension holding the
// permissions makes a bookmark the bar draws at once and is told of it, reads and deletes history the History
// page shows, lists the most visited sites, and opens the default engine's results in a new tab; an
// extension without them sees no such namespace, and one that declares them but was never granted is refused.
// Set ORIVON_SHOTS_DIR to also write screenshots in both colour schemes.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { activeTabInfo, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 180_000
const SHOTS = process.env['ORIVON_SHOTS_DIR']

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What prefs.json holds for an extension the person granted these optional permissions. */
function grant (dir: string, id: string, permissions: string[]): void {
  writeFileSync(join(dir, 'extensions', 'prefs.json'), JSON.stringify({ version: 1, extensions: { [id]: { granted: { permissions, origins: [] } } } }))
}

async function launched (seed: (dir: string) => void): Promise<ElectronApplication> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], seedProfile: (dir: string) => { seed(dir) }, sandbox: true })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) > 0)).toBe(true)
  await waitRecovered(app)
  return app
}

async function visit (chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

const barTitles = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('#bookmarks-list .bmitem')).filter((el) => !el.hidden).map((el) => el.getAttribute('aria-label') ?? ''))

const tabCount = async (chrome: Page): Promise<number> => await evaluateRetrying(chrome, () => document.querySelectorAll('.tab').length)

interface Node { id: string, title: string, url?: string, children?: Node[] }
type Logged = Array<{ event: string, args: unknown[] }>

async function result<T> (app: ElectronApplication, wc: number, path: string, args: unknown[] = []): Promise<T> {
  const reply = await rpc(app, wc, path, args)
  if (!reply.ok) throw new Error(reply.error)
  return reply.result as T
}

async function shootBar (chrome: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  await chrome.mouse.move(700, 14)
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await chrome.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), clip: { x: 0, y: 0, width: await chrome.evaluate(() => window.innerWidth), height: 104 } })
  }
  await chrome.emulateMedia({ colorScheme: null })
}

it('lets an extension with the permissions manage bookmarks, read history, list top sites and search', async () => {
  let id = ''
  const app = await launched((dir) => { id = seedFixture(dir, 'api-sweep'); grant(dir, id, ['bookmarks', 'history']) })
  try {
    const chrome = findChrome(app)
    const wc = await openExtensionPage(app, id, 'page.html')

    // A bookmark an extension creates is an ordinary one: the bar draws it, the tree holds it, the worker is told.
    const created = await result<Node & { parentId: string, index: number }>(app, wc, 'chrome.bookmarks.create', [{ parentId: '1', title: 'Made by an extension', url: 'https://example.test/' }])
    expect(created).toMatchObject({ title: 'Made by an extension', parentId: '1', index: 0 })
    expect(await waitFor(async () => (await barTitles(chrome)).includes('Made by an extension'))).toBe(true)
    await shootBar(chrome, 'bar-extension-bookmark')
    const [tree] = await result<Node[]>(app, wc, 'chrome.bookmarks.getTree')
    const bar = tree?.children?.find((node) => node.id === '1')
    expect(bar?.children?.map((node) => node.title)).toEqual(['Made by an extension'])
    expect(await waitFor(async () => (await result<Logged>(app, wc, '__libraryEvents')).some((entry) => entry.event === 'bookmarks.onCreated'))).toBe(true)
    expect(await result<Node[]>(app, wc, 'chrome.bookmarks.search', ['extension'])).toHaveLength(1)

    // The roots are not the extension's to change; a bookmarklet is refused.
    expect(await rpc(app, wc, 'chrome.bookmarks.remove', ['1'])).toEqual({ ok: false, error: "Can't modify the root bookmark folders." })
    expect(await rpc(app, wc, 'chrome.bookmarks.create', [{ title: 'x', url: 'javascript:alert(1)' }])).toEqual({ ok: false, error: 'Invalid URL.' })

    await result(app, wc, 'chrome.bookmarks.remove', [created.id])
    expect(await waitFor(async () => !(await barTitles(chrome)).includes('Made by an extension'))).toBe(true)
    expect((await result<Logged>(app, wc, '__libraryEvents')).some((entry) => entry.event === 'bookmarks.onRemoved')).toBe(true)

    // History: two visits of one page, a visit of another between them.
    await visit(chrome, `${origin}/one`)
    await visit(chrome, `${origin}/two`)
    await visit(chrome, `${origin}/one`)
    const found = await result<Array<{ url: string, visitCount: number, title: string }>>(app, wc, 'chrome.history.search', [{ text: '' }])
    expect(found.find((item) => item.url === `${origin}/one`)).toMatchObject({ visitCount: 2, title: 'Page /one' })
    expect((await result<Logged>(app, wc, '__libraryEvents')).filter((entry) => entry.event === 'history.onVisited').length).toBeGreaterThanOrEqual(3)
    const sites = await result<Array<{ url: string }>>(app, wc, 'chrome.topSites.get')
    expect(sites.map((site) => site.url)).toContain(`${origin}/one`)
    expect(await result<unknown[]>(app, wc, 'chrome.history.getVisits', [{ url: `${origin}/one` }])).toHaveLength(1)

    // Deleting a page shows on the History page at once.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('history') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://history')))).toBe(true)
    const historyPage = app.windows().find((w) => w.url().startsWith('orivon://history')) as Page
    await historyPage.waitForSelector('.page')
    expect(await waitFor(async () => (await historyPage.locator('.entry .title').allTextContents()).includes('Page /one'))).toBe(true)
    await result(app, wc, 'chrome.history.deleteUrl', [{ url: `${origin}/one` }])
    expect(await waitFor(async () => !(await historyPage.locator('.entry .title').allTextContents()).includes('Page /one'))).toBe(true)
    expect((await result<Logged>(app, wc, '__libraryEvents')).some((entry) => entry.event === 'history.onVisitRemoved')).toBe(true)

    // search.query opens the default engine's results in a new tab, as the address bar would (a fresh profile searches the Web3 with Explore), and refuses both a tab and a disposition.
    const before = await tabCount(chrome)
    await result(app, wc, 'chrome.search.query', [{ text: 'orivon browser', disposition: 'NEW_TAB' }])
    expect(await waitFor(async () => (await tabCount(chrome)) === before + 1)).toBe(true)
    expect(await waitFor(async () => String((await activeTabInfo(chrome) as { address?: string }).address).startsWith('ipfs://explore.orivonstack.eth/#/search?q=orivon+browser'))).toBe(true)
    expect(await rpc(app, wc, 'chrome.search.query', [{ text: 'x', tabId: 1, disposition: 'NEW_TAB' }])).toEqual({ ok: false, error: "Cannot set both 'disposition' and 'tabId'." })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('gives an extension without the permissions no such namespace, and refuses one that was never granted', async () => {
  let plainId = ''
  let sweepId = ''
  const app = await launched((dir) => { plainId = seedFixture(dir, 'action-popup'); sweepId = seedFixture(dir, 'api-sweep') })
  try {
    // No manifest line at all: the namespaces are not there.
    const plain = await openExtensionPage(app, plainId, 'options.html')
    const seen = await app.evaluate(async ({ webContents }, wcId: number) => await webContents.fromId(wcId)?.executeJavaScript(
      'JSON.stringify(["bookmarks", "history", "search"].map((name) => typeof chrome[name]))', true), plain)
    expect(JSON.parse(String(seen))).toEqual(['undefined', 'undefined', 'undefined'])

    // Declared as optional, never granted: the call is refused.
    const sweep = await openExtensionPage(app, sweepId, 'page.html')
    expect(JSON.stringify(await rpc(app, sweep, 'chrome.bookmarks.getTree'))).toContain('requires an extension with bookmarks permissions')
    expect(JSON.stringify(await rpc(app, sweep, 'chrome.history.search', [{ text: '' }]))).toContain('requires an extension with history permissions')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
