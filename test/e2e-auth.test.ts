// HTTP sign-in in the running shell: a server, a part of a page and a proxy each get a sheet that names who
// asked; a wrong answer asks again with the username kept; Cancel leaves the server's own 401 page; a tab
// switch hides the sheet and brings it back. Set ORIVON_UI_SHOTS_DIR to also write screenshots of each sheet
// in both colour schemes.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { safely, overlayShown, runCommand, shoot, waitOverlay } from './auth-support.js'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const USER = 'alice'
const PASSWORD = 'open-sesame'
const GOOD = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`

interface Fixture { server: Server, port: number, seen: Array<{ url: string, authorization: string | undefined }> }

/** A server that answers 401 for `realm` until the request carries the right Basic header. */
async function authServer (routes: (request: IncomingMessage, response: ServerResponse) => boolean): Promise<Fixture> {
  const seen: Fixture['seen'] = []
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', authorization: request.headers.authorization })
    if (!routes(request, response)) { response.statusCode = 404; response.end('no') }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, port: (server.address() as AddressInfo).port, seen }
}

function guarded (request: IncomingMessage, response: ServerResponse, realm: string, title: string): void {
  if (request.headers.authorization === GOOD) {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>${title}</title><h1>Welcome ${USER}</h1>`)
    return
  }
  response.statusCode = 401
  response.setHeader('www-authenticate', `Basic realm="${realm}"`)
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><title>Denied</title><h1>Denied 401</h1>')
}

let site: Fixture
let images: Fixture
let proxy: Fixture

beforeAll(async () => {
  images = await authServer((request, response) => {
    if (!request.url?.startsWith('/protected.png')) return false
    if (request.headers.authorization === GOOD) { response.setHeader('content-type', 'image/png'); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')) } else {
      response.statusCode = 401
      response.setHeader('www-authenticate', 'Basic realm="Images"')
      response.end('no')
    }
    return true
  })
  site = await authServer((request, response) => {
    const url = request.url ?? ''
    if (url.startsWith('/secret')) { guarded(request, response, 'Staging', 'Secret area'); return true }
    if (url.startsWith('/cancel')) { guarded(request, response, 'Cancel', 'Cancelled area'); return true }
    if (url.startsWith('/hold')) { guarded(request, response, 'Hold', 'Held area'); return true }
    if (url.startsWith('/long')) { guarded(request, response, `${'Very long realm '.repeat(8)}`, 'Long'); return true }
    if (url.startsWith('/page')) {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>Embedding page</title><h1>Embedding</h1><img src="http://127.0.0.1:${String(images.port)}/protected.png">`)
      return true
    }
    return false
  })
  proxy = await authServer((request, response) => {
    if (request.headers['proxy-authorization'] === GOOD) {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Via the proxy</title><h1>Proxied</h1>')
      return true
    }
    response.statusCode = 407
    response.setHeader('proxy-authenticate', 'Basic realm="Corp proxy"')
    response.end('proxy says no')
    return true
  })
})

afterAll(async () => {
  for (const fixture of [site, images, proxy]) await new Promise<void>((resolve) => { fixture.server.close(() => { resolve() }); fixture.server.closeAllConnections() })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function start (args: string[] = []): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER, ...args] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** Types the address and does not wait for the page: a server that wants a password never commits one. */
async function go (chrome: Page, url: string): Promise<void> {
  await clickAddressBarRetrying(chrome, url)
}

const text = async (page: Page, selector: string): Promise<string> => (await page.locator(selector).first().innerText()).trim()
const count = async (page: Page, selector: string): Promise<number> => await page.locator(selector).count()

it('asks for a server\'s password in a sheet: the asker, the warning, a wrong answer, the right one', async () => {
  const { app, chrome } = await start()
  try {
    await go(chrome, `http://127.0.0.1:${String(site.port)}/secret`)
    let sheet = await waitOverlay(app, 'auth-sheet')
    await sheet.waitForSelector('#auth-username')
    expect(await text(sheet, '.sheet-title')).toBe('Sign in')
    expect(await text(sheet, '.origin')).toBe(`http://127.0.0.1:${String(site.port)}`)
    expect(await text(sheet, '.auth-line')).toBe('This site is asking for a username and password.')
    expect(await text(sheet, '.auth-realm')).toBe('The site calls this area "Staging".')
    expect(await text(sheet, '.banner.warn')).toBe('Your password will be sent without encryption.')
    expect(await count(sheet, '.problem')).toBe(0)
    expect(await count(sheet, '.banner.warn')).toBe(1)
    expect(await sheet.locator('button[type=submit]').isDisabled()).toBe(true)
    expect(await sheet.evaluate(() => document.activeElement?.id)).toBe('auth-username')
    expect(await sheet.locator('#auth-password').getAttribute('type')).toBe('password')
    await shoot(app, chrome, sheet, 'auth-empty')

    await sheet.fill('#auth-username', USER)
    await sheet.fill('#auth-password', 'wrong-one')
    expect(await sheet.locator('button[type=submit]').isDisabled()).toBe(false)
    // The eye shows what was typed, and hides it again.
    await sheet.click('button[aria-label="Show password"]')
    expect(await sheet.locator('#auth-password').getAttribute('type')).toBe('text')
    await shoot(app, chrome, sheet, 'auth-filled')
    await sheet.click('button[aria-label="Hide password"]')
    expect(await sheet.locator('#auth-password').getAttribute('type')).toBe('password')
    await safely(sheet.press('#auth-password', 'Enter'))

    // The server asks again: a new sheet with the error and the username kept.
    expect(await waitFor(async () => {
      const again = app.windows().filter((w) => w.url().includes('overlay=auth-sheet') && !w.isClosed()).at(-1)
      if (again === undefined || !(await overlayShown(app, 'auth-sheet'))) return false
      try { return await again.locator('.problem').count() === 1 } catch { return false }
    })).toBe(true)
    sheet = await waitOverlay(app, 'auth-sheet')
    expect(await text(sheet, '.problem')).toBe('That username or password was not accepted.')
    expect(await sheet.locator('#auth-username').inputValue()).toBe(USER)
    expect(await sheet.evaluate(() => document.activeElement?.id)).toBe('auth-password')
    await shoot(app, chrome, sheet, 'auth-retry')

    await sheet.fill('#auth-password', PASSWORD)
    await safely(sheet.click('button[type=submit]'))
    const signedIn = await waitForTab(chrome, { title: 'Secret area' })
    expect(signedIn.ok, JSON.stringify(signedIn.info)).toBe(true)
    expect(await waitFor(async () => !(await overlayShown(app, 'auth-sheet')))).toBe(true)
    // The password went to the server as Basic, and nowhere the page could read it.
    expect(site.seen.some((entry) => entry.authorization === GOOD)).toBe(true)
    expect(mainOutput(app)).not.toContain(PASSWORD)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Cancel and Escape leave the server\'s own 401 page, and a cancelled server is not asked again for that page', async () => {
  const { app, chrome } = await start()
  try {
    await go(chrome, `http://127.0.0.1:${String(site.port)}/cancel`)
    const sheet = await waitOverlay(app, 'auth-sheet')
    await sheet.waitForSelector('#auth-username')
    expect(await text(sheet, '.auth-realm')).toBe('The site calls this area "Cancel".')
    await safely(sheet.click('button:has-text("Cancel")'))
    const denied = await waitForTab(chrome, { title: 'Denied' })
    expect(denied.ok, JSON.stringify(denied.info)).toBe(true)
    expect(await waitFor(async () => !(await overlayShown(app, 'auth-sheet')))).toBe(true)

    // A reload is a new page load: the question comes back, and Escape answers it the same way.
    await runCommand(chrome, 'nav.reload')
    const second = await waitOverlay(app, 'auth-sheet')
    await second.waitForSelector('#auth-username')
    await safely(second.keyboard.press('Escape'))
    expect(await waitFor(async () => !(await overlayShown(app, 'auth-sheet')))).toBe(true)
    expect((await waitForTab(chrome, { title: 'Denied' })).ok).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('hides a tab\'s sheet when the person leaves the tab and shows it again on return', async () => {
  const { app, chrome } = await start()
  try {
    await go(chrome, `http://127.0.0.1:${String(site.port)}/hold`)
    const sheet = await waitOverlay(app, 'auth-sheet')
    await sheet.waitForSelector('#auth-username')
    await runCommand(chrome, 'tab.new')
    expect(await waitFor(async () => !(await overlayShown(app, 'auth-sheet')))).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await overlayShown(app, 'auth-sheet')).toBe(false)
    await runCommand(chrome, 'tab.previous')
    const back = await waitOverlay(app, 'auth-sheet')
    await back.waitForSelector('#auth-username')
    expect(await text(back, '.auth-realm')).toBe('The site calls this area "Hold".')
    await back.fill('#auth-username', USER)
    await back.fill('#auth-password', PASSWORD)
    await safely(back.click('button[type=submit]'))
    expect((await waitForTab(chrome, { title: 'Held area' })).ok).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says when a request comes from a part of the page and not the page itself', async () => {
  const { app, chrome } = await start()
  try {
    await go(chrome, `http://127.0.0.1:${String(site.port)}/page`)
    const sheet = await waitOverlay(app, 'auth-sheet')
    await sheet.waitForSelector('#auth-username')
    expect(await text(sheet, '.origin')).toBe(`http://127.0.0.1:${String(images.port)}`)
    expect(await text(sheet, '.auth-realm')).toBe('The site calls this area "Images".')
    const warnings = await sheet.locator('.banner.warn').allInnerTexts()
    expect(warnings).toContain(`This request comes from 127.0.0.1:${String(images.port)}, not from the page you are on.`)
    expect(warnings).toContain('Your password will be sent without encryption.')
    await shoot(app, chrome, sheet, 'auth-subresource')
    await safely(sheet.click('button:has-text("Cancel")'))
    expect((await waitForTab(chrome, { title: 'Embedding page' })).ok).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows no realm that is too long to be a name', async () => {
  const { app, chrome } = await start()
  try {
    await go(chrome, `http://127.0.0.1:${String(site.port)}/long`)
    const sheet = await waitOverlay(app, 'auth-sheet')
    await sheet.waitForSelector('#auth-username')
    expect(await count(sheet, '.auth-realm')).toBe(0)
    await safely(sheet.keyboard.press('Escape'))
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('asks for a proxy\'s password too, and names the proxy, not the site', async () => {
  const { app, chrome } = await start([`--proxy-server=127.0.0.1:${String(proxy.port)}`])
  try {
    await go(chrome, 'http://proxied.test/')
    const sheet = await waitOverlay(app, 'auth-sheet')
    await sheet.waitForSelector('#auth-username')
    expect(await text(sheet, '.sheet-title')).toBe('Sign in to the proxy')
    expect(await text(sheet, '.origin')).toBe(`127.0.0.1:${String(proxy.port)}`)
    expect(await text(sheet, '.auth-line')).toBe('This proxy needs a username and password.')
    expect(await count(sheet, '.banner')).toBe(0)
    await shoot(app, chrome, sheet, 'auth-proxy')
    await sheet.fill('#auth-username', USER)
    await sheet.fill('#auth-password', PASSWORD)
    await safely(sheet.click('button[type=submit]'))
    const loaded = await waitForTab(chrome, { title: 'Via the proxy' })
    expect(loaded.ok, JSON.stringify(loaded.info)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
