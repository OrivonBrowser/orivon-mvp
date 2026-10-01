// Cookies and site data in the running shell. Two loopback sites on different hosts (127.0.0.1 and localhost)
// each keep cookies, local storage, IndexedDB and Cache Storage. The site-info popover lists the first site's
// cookies by name only (a value never reaches the page), deletes one or all behind two presses, and leaves the
// other site alone. Settings > Privacy lists both sites, narrows by search, opens a site onto its cookies and
// deletes one cookie, one site and everything. Control+Shift+Delete opens Settings at the clear-data row. A
// private window lists its own session's data. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour
// schemes and the on-disk layout the site list is built from.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCommand, SHOTS_DIR, shoot } from './auth-support.js'
import { pressKey } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { findChrome, waitFor } from './smoke-helpers.mjs'
import { visit } from './qa-helpers.js'

const TEST_TIMEOUT_MS = 180_000
const RESOLVER = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'
const SECRET = 'secret-value'

interface Fixture { server: Server, origin: string }

/** `/` writes local storage, IndexedDB and Cache Storage; `/check` only reads what is there. */
function page (writes: boolean): string {
  return `<!doctype html><title>working</title><script>
(async () => {
  try {
    ${writes
      ? `localStorage.setItem('k', 'v')
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('fixture', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    await new Promise((resolve, reject) => { const t = db.transaction('s', 'readwrite'); t.objectStore('s').put('x'.repeat(5000), 'k'); t.oncomplete = resolve; t.onerror = () => reject(t.error) })
    db.close()
    const cache = await caches.open('c1')
    await cache.put('/x', new Response('data'))`
      : ''}
    const dbs = await indexedDB.databases()
    document.title = 'dbs=' + dbs.length + ';ls=' + localStorage.length
  } catch (e) { document.title = 'error ' + e }
})()
</script>`
}

async function site (host: string, cookies: string[]): Promise<Fixture> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.setHeader('set-cookie', cookies)
    response.end(page(request.url !== '/check'))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, origin: `http://${host}:${String((server.address() as AddressInfo).port)}` }
}

let a: Fixture
let b: Fixture
let app: ElectronApplication
let chrome: Page

beforeAll(async () => {
  a = await site('127.0.0.1', [`a=${SECRET}-1; Path=/; Max-Age=86400`, `b=${SECRET}-2; Path=/; HttpOnly; Max-Age=86400`, `c=${SECRET}-3; Path=/`])
  b = await site('localhost', [`z=${SECRET}-4; Path=/; Max-Age=86400`])
})

afterAll(async () => {
  await closeElectron(app).catch(() => undefined)
  for (const fixture of [a, b]) await new Promise<void>((resolve) => { fixture.server.close(() => { resolve() }); fixture.server.closeAllConnections() })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const cookieNames = async (host: string): Promise<string[]> =>
  await app.evaluate(async ({ session }, domain) => (await session.defaultSession.cookies.get({})).filter((cookie) => cookie.domain?.replace(/^\./, '') === domain).map((cookie) => cookie.name).sort(), host)

/** The tab's title once the fixture page has counted what its origin keeps. */
async function visitCounted (url: string, counted: string): Promise<Page> {
  const view = await visit(app, chrome, url)
  expect(await waitFor(async () => (await view.title()) === counted, 15_000), `${url} counted ${counted}`).toBe(true)
  return view
}

const indexedDbFolders = async (): Promise<string[]> => {
  const storage = await app.evaluate(({ session }) => session.defaultSession.storagePath)
  try { return readdirSync(join(storage as string, 'IndexedDB')) } catch { return [] }
}

const cookieRow = (window: Page, name: string): Locator => window.locator('.cookie-row').filter({ has: window.locator('.cookie-name', { hasText: new RegExp(`^${name}$`) }) })

const popup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())
const settings = (): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://settings') && !w.isClosed())

async function openDataPage (): Promise<Page> {
  await chrome.click('#web3-score-btn')
  expect(await waitFor(() => popup() !== undefined)).toBe(true)
  const window = popup() as Page
  await window.waitForSelector('.back-row')
  await window.click('.back-row')
  await window.click('button.nav-row:has-text("Cookies and site data")')
  await window.waitForSelector('#cookies-toggle')
  return window
}

async function closePopup (): Promise<void> {
  if (popup() === undefined) return
  await chrome.click('#web3-score-btn')
  expect(await waitFor(() => popup() === undefined)).toBe(true)
  await chrome.waitForTimeout(400)
}

it('lists a site\'s cookies by name, deletes one, then all, and leaves the other site alone', async () => {
  app = await launchElectron({ appPath: '.', args: [RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  chrome = findChrome(app)

  await visitCounted(`${b.origin}/`, 'dbs=1;ls=1')
  await visitCounted(`${a.origin}/`, 'dbs=1;ls=1')
  expect(await cookieNames('127.0.0.1')).toEqual(['a', 'b', 'c'])
  expect(await cookieNames('localhost')).toEqual(['z'])

  if (SHOTS_DIR !== undefined) {
    mkdirSync(SHOTS_DIR, { recursive: true })
    const storage = await app.evaluate(({ session }) => session.defaultSession.storagePath)
    const layout: Record<string, string[]> = {}
    for (const folder of ['IndexedDB', 'Local Storage', 'Service Worker', 'Service Worker/CacheStorage', 'File System', 'Storage']) {
      try { layout[folder] = readdirSync(join(storage as string, folder)) } catch { layout[folder] = ['(missing)'] }
    }
    const partitioned = await app.evaluate(async ({ session }) => (await session.defaultSession.cookies.get({})).map((cookie) => Object.keys(cookie).sort().join(',')))
    writeFileSync(join(SHOTS_DIR, 'probe-layout.json'), JSON.stringify({ storage, layout, cookieKeys: [...new Set(partitioned)] }, null, 2))
  }

  const window = await openDataPage()
  expect(await window.locator('.stat-row', { hasText: 'Cookies' }).first().locator('.stat-value').textContent()).toBe('3')
  expect(await window.locator('.cookie-row').count()).toBe(0)
  await shoot(app, chrome, window, 'popover-collapsed')

  await window.click('#cookies-toggle')
  expect(await window.getAttribute('#cookies-toggle', 'aria-expanded')).toBe('true')
  expect(await window.locator('.cookie-name').allTextContents()).toEqual(['a', 'b', 'c'])
  expect(await cookieRow(window, 'b').locator('.badge').allTextContents()).toEqual(['HttpOnly'])
  expect(await cookieRow(window, 'c').textContent()).toContain('until you close Orivon')
  expect(await cookieRow(window, 'a').textContent()).toMatch(/expires \d/)
  // The page holds no value, not in its text and not in any attribute.
  expect(await window.evaluate(() => document.documentElement.outerHTML)).not.toContain(SECRET)
  expect(await window.getByText('localhost').count()).toBe(0)
  await shoot(app, chrome, window, 'popover-cookies')

  // One cookie goes at once, and the page says the tab must be reloaded to see it.
  await window.click('button[aria-label="Delete cookie b"]')
  expect(await waitFor(async () => (await cookieNames('127.0.0.1')).join() === 'a,c')).toBe(true)
  await window.waitForSelector('.reload-banner')
  expect(await window.locator('.reload-banner').textContent()).toContain('Reload to see the change.')
  expect(await window.locator('.cookie-name').allTextContents()).toEqual(['a', 'c'])
  await shoot(app, chrome, window, 'popover-deleted')

  // All of them need two presses.
  await window.click('#clear-cookies')
  expect(await window.textContent('#clear-cookies')).toBe('Click again to delete')
  expect((await cookieNames('127.0.0.1')).length).toBe(2)
  await shoot(app, chrome, window, 'popover-armed')
  await window.click('#clear-cookies')
  expect(await waitFor(async () => (await cookieNames('127.0.0.1')).length === 0)).toBe(true)
  expect(await cookieNames('localhost')).toEqual(['z'])
  await window.waitForSelector('text=This site has not stored any cookies.')
  await shoot(app, chrome, window, 'popover-empty')
  await closePopup()
}, TEST_TIMEOUT_MS)

it('opens Settings at the clear-data row on Control+Shift+Delete, with the first box focused', async () => {
  await pressKey(app, a.origin, 'Delete', ['control', 'shift'])
  expect(await waitFor(() => settings() !== undefined)).toBe(true)
  const window = settings() as Page
  await window.waitForSelector('#row-clear-data')
  expect(await window.evaluate(() => location.pathname + location.hash)).toBe('/privacy')
  expect(await waitFor(async () => await window.evaluate(() => document.activeElement?.closest('#row-clear-data') !== null && document.activeElement?.tagName === 'INPUT'))).toBe(true)
  expect(await window.evaluate(() => document.querySelector('#row-clear-data')?.classList.contains('flash'))).toBe(true)
  await shoot(app, chrome, window, 'settings-clear-data-row')
}, TEST_TIMEOUT_MS)

it('lists both sites in Settings, searches, and deletes a cookie, a site and everything', async () => {
  const window = settings() as Page
  await window.reload()
  await window.waitForSelector('#site-data .sd-site')
  const domains = async (): Promise<string[]> => await window.locator('#site-data .sd-domain').allTextContents()
  expect((await domains()).sort()).toEqual(['127.0.0.1', 'localhost'])
  expect(await window.locator('#row-site-data-total .value').textContent()).toMatch(/^About \d/)
  const first = window.locator('.sd-site', { hasText: '127.0.0.1' })
  expect(await first.locator('.sd-line').textContent()).toContain('IndexedDB')
  expect(await first.locator('.sd-line').textContent()).toMatch(/\d+(\.\d)? (B|KB|MB)/)
  expect(await window.locator('.sd-site', { hasText: 'localhost' }).locator('.sd-line').textContent()).toContain('1 cookie')
  await shoot(app, chrome, window, 'settings-site-list')

  await window.fill('#site-data input[type="search"]', 'local')
  expect(await domains()).toEqual(['localhost'])
  await window.fill('#site-data input[type="search"]', 'nothing')
  await window.waitForSelector('#site-data .empty-state:has-text("No sites match.")')
  await shoot(app, chrome, window, 'settings-site-no-match')
  await window.fill('#site-data input[type="search"]', '')

  await window.click('#site-data .segmented button:has-text("Name")')
  expect(await domains()).toEqual(['127.0.0.1', 'localhost'])

  // A site opens onto its host and cookie names; no value is anywhere on the page.
  await window.click('button[aria-label="Show what localhost stores"]')
  await window.waitForSelector('.sd-hosts .cookie-name')
  expect(await window.locator('.sd-hosts .cookie-name').allTextContents()).toEqual(['z'])
  expect(await window.evaluate(() => document.documentElement.outerHTML)).not.toContain(SECRET)
  await shoot(app, chrome, window, 'settings-site-expanded')

  // Deleting the first site takes its cookies and its IndexedDB, and leaves the second site whole.
  await window.click('button[aria-label="Delete data for 127.0.0.1"]')
  await window.waitForSelector('.sd-row .btn.danger.armed')
  await shoot(app, chrome, window, 'settings-site-armed')
  await window.click('.sd-row .btn.danger.armed')
  expect(await waitFor(async () => (await domains()).join() === 'localhost')).toBe(true)
  expect(await cookieNames('127.0.0.1')).toEqual([])
  expect(await cookieNames('localhost')).toEqual(['z'])
  // The pages themselves agree: the first site's IndexedDB and local storage are gone, the second's are not.
  await runCommand(chrome, 'tab.new')
  await visitCounted(`${a.origin}/check`, 'dbs=0;ls=0')
  await visitCounted(`${b.origin}/check`, 'dbs=1;ls=1')
  await pressKey(app, b.origin, 'W', ['control'])
  expect(await waitFor(async () => (await window.evaluate(() => document.visibilityState)) === 'visible')).toBe(true)

  // A cookie goes at once, and a site with nothing left drops off the list.
  await window.waitForSelector('.sd-hosts .cookie-name')
  await window.click('button[aria-label="Delete cookie z"]')
  expect(await waitFor(async () => (await cookieNames('localhost')).length === 0)).toBe(true)
  expect(await domains()).toEqual(['localhost'])
  await window.click('#site-data .sd-foot .btn.danger')
  expect(await window.textContent('#site-data .sd-foot .btn.danger')).toBe('Click again to delete all site data')
  await shoot(app, chrome, window, 'settings-delete-all-armed')
  await window.click('#site-data .sd-foot .btn.danger')
  await window.waitForSelector('#site-data .empty-state:has-text("No site has stored data.")')
  expect(await indexedDbFolders()).toEqual([])
  await shoot(app, chrome, window, 'settings-site-empty')
}, TEST_TIMEOUT_MS)

it('lists only its own session\'s data in a private window', async () => {
  await closeElectron(app)
  app = await launchElectron({ appPath: '.', args: [RESOLVER, '--orivon-private'] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  chrome = findChrome(app)
  await visit(app, chrome, `${a.origin}/`)
  await runCommand(chrome, 'privacy.clearData')
  expect(await waitFor(() => settings() !== undefined)).toBe(true)
  const window = settings() as Page
  await window.waitForSelector('#site-data .sd-site')
  expect(await window.locator('#site-data .sd-domain').allTextContents()).toEqual(['127.0.0.1'])
  expect(await window.locator('.sd-site .sd-line').textContent()).toContain('3 cookies')
  await shoot(app, chrome, window, 'settings-site-private')
}, TEST_TIMEOUT_MS)
