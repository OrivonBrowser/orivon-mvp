// The network privacy controls in the running shell, measured on the wire: which headers a fixture server
// receives, which cookies reach it and are stored, what HTTPS-only does to a mapped name and to the loopback
// fixtures every other test uses, and the sheet that offers the way through. Screenshots go to the directory
// named by ORIVON_PRIVACY_NET_SHOTS when it is set.
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { ABSENCE_SETTLE_MS, findChrome, popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

interface Seen { readonly url: string, readonly headers: IncomingHttpHeaders }

const SHOTS = process.env['ORIVON_PRIVACY_NET_SHOTS']
const TEST_TIMEOUT_MS = 90_000
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

let firstParty: Server
let thirdParty: Server
let plain: Server
let tls: Server
let tlsDir = ''
let tlsPort = 0
const firstSeen: Seen[] = []
const thirdSeen: Seen[] = []
const plainSeen: Seen[] = []
let firstPort = 0
let thirdPort = 0
let plainPort = 0

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

beforeAll(async () => {
  // Reached as 127.0.0.1 (the page) and localhost (the embedded image), which are two sites.
  thirdParty = createServer((request, response) => {
    thirdSeen.push({ url: request.url ?? '', headers: request.headers })
    const name = new URL(request.url ?? '/', 'http://x').searchParams.get('n') ?? 'x'
    response.setHeader('content-type', 'image/gif')
    response.setHeader('set-cookie', `${name}=1; Path=/; SameSite=None; Secure`)
    response.end(GIF)
  })
  thirdPort = await listen(thirdParty)
  firstParty = createServer((request, response) => {
    firstSeen.push({ url: request.url ?? '', headers: request.headers })
    if (request.url === '/self.gif') {
      response.setHeader('content-type', 'image/gif')
      response.end(GIF)
      return
    }
    const name = new URL(request.url ?? '/', 'http://x').searchParams.get('n') ?? 'x'
    response.setHeader('content-type', 'text/html')
    response.setHeader('set-cookie', 'first=1; Path=/')
    response.end(`<!doctype html><title>first ${name}</title><img src="/self.gif"><img src="http://localhost:${String(thirdPort)}/pixel?n=${name}">`)
  })
  firstPort = await listen(firstParty)
  plain = createServer((request, response) => {
    plainSeen.push({ url: request.url ?? '', headers: request.headers })
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>plain ${request.url ?? ''}</title><p>plain</p>`)
  })
  plainPort = await listen(plain)
  // A server whose certificate nobody vouches for: an address upgraded to https that lands here fails on the certificate.
  tlsDir = mkdtempSync(join(tmpdir(), 'orivon-privacy-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=selfsigned.test', '-addext', 'subjectAltName=DNS:selfsigned.test',
    '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem')], { stdio: 'ignore' })
  tls = createTlsServer({ key: readFileSync(join(tlsDir, 'key.pem')), cert: readFileSync(join(tlsDir, 'cert.pem')) }, (_request, response) => { response.end('tls') })
  tlsPort = await listen(tls)
  if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true })
})

afterAll(async () => {
  for (const server of [firstParty, thirdParty, plain, tls]) await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections?.() })
  rmSync(tlsDir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/**
 * Everything but loopback and localhost is unresolvable; `up.test` and `down.test` are mapped to the plain fixture's
 * port, so an address with no port reaches it over http, and the https address an upgrade makes reaches it too and
 * fails the handshake. `selfsigned.test` is mapped to the server whose certificate nobody vouches for.
 */
const resolver = (): string => `--host-resolver-rules=MAP up.test 127.0.0.1:${String(plainPort)}, MAP down.test 127.0.0.1:${String(plainPort)}, MAP selfsigned.test 127.0.0.1:${String(tlsPort)}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`

async function seed (dir: string, values: Record<string, string | boolean>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values }))
}

async function launched (values: Record<string, string | boolean>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [resolver()], seedProfile: async (dir) => { await seed(dir, values) } })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function visit (chrome: Page, url: string): Promise<void> {
  await clickAddressBarRetrying(chrome, url)
}

const cookiesNamed = async (app: ElectronApplication, name: string): Promise<number> =>
  await app.evaluate(async ({ session }, n) => (await session.defaultSession.cookies.get({ name: n })).length, name)

const hasSeen = (list: Seen[], part: string): boolean => list.some((seen) => seen.url.includes(part))
const seenWith = (list: Seen[], part: string): Seen | undefined => list.find((seen) => seen.url.includes(part))

async function openSettings (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('#row-cookies')
  return page
}

const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

function savedSetting (userData: string, key: string): unknown {
  try { return (JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { values: Record<string, unknown> }).values[key] } catch { return undefined }
}

async function shoot (page: Page, name: string, clip?: { x: number, y: number, width: number, height: number }): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await waitFor(async () => await page.evaluate((t) => matchMedia('(prefers-color-scheme: dark)').matches === (t === 'dark'), theme))
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), ...(clip === undefined ? {} : { clip }) })
  }
  await page.emulateMedia({ colorScheme: null })
}

it('sends Sec-GPC and DNT when they are on, and lets every cookie through', async () => {
  const { app, chrome } = await launched({ 'privacy.globalPrivacyControl': true, 'privacy.doNotTrack': true })
  try {
    await visit(chrome, `http://127.0.0.1:${String(firstPort)}/?n=one`)
    expect(await waitFor(() => hasSeen(thirdSeen, 'n=one'))).toBe(true)
    expect(seenWith(firstSeen, '/?n=one')?.headers['sec-gpc']).toBe('1')
    expect(seenWith(firstSeen, '/?n=one')?.headers['dnt']).toBe('1')
    expect(seenWith(thirdSeen, 'n=one')?.headers['sec-gpc']).toBe('1')
    expect(seenWith(thirdSeen, 'n=one')?.headers['dnt']).toBe('1')
    expect(await waitFor(async () => (await cookiesNamed(app, 'one')) === 1)).toBe(true)

    await visit(chrome, `http://127.0.0.1:${String(firstPort)}/?n=two`)
    expect(await waitFor(() => hasSeen(thirdSeen, 'n=two'))).toBe(true)
    expect(seenWith(thirdSeen, 'n=two')?.headers['cookie']).toContain('one=1')

    const tab = app.windows().find((w) => w.url().includes(`127.0.0.1:${String(firstPort)}`))
    expect(await tab?.evaluate(() => (navigator as unknown as { globalPrivacyControl?: unknown }).globalPrivacyControl)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('sends neither signal when both are off, and strips a cross-site cookie at both ends when third-party cookies are blocked', async () => {
  const { app, chrome } = await launched({ 'privacy.cookies': 'blockThirdParty', 'privacy.globalPrivacyControl': false })
  try {
    await visit(chrome, `http://127.0.0.1:${String(firstPort)}/?n=blocked`)
    expect(await waitFor(() => hasSeen(thirdSeen, 'n=blocked'))).toBe(true)
    expect(seenWith(firstSeen, '/?n=blocked')?.headers['sec-gpc']).toBeUndefined()
    expect(seenWith(firstSeen, '/?n=blocked')?.headers['dnt']).toBeUndefined()
    expect(seenWith(thirdSeen, 'n=blocked')?.headers['sec-gpc']).toBeUndefined()

    // The first-party cookie is stored and comes back on the page's own image.
    expect(await waitFor(async () => (await cookiesNamed(app, 'first')) === 1)).toBe(true)
    await visit(chrome, `http://127.0.0.1:${String(firstPort)}/?n=again`)
    expect(await waitFor(() => hasSeen(thirdSeen, 'n=again'))).toBe(true)
    await waitFor(() => firstSeen.filter((seen) => seen.url === '/self.gif').length >= 2)
    expect(firstSeen.filter((seen) => seen.url === '/self.gif').at(-1)?.headers['cookie']).toContain('first=1')

    // The cross-site image set a cookie and had none sent back: neither end of it got through.
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(await cookiesNamed(app, 'blocked')).toBe(0)
    expect(await cookiesNamed(app, 'again')).toBe(0)
    expect(seenWith(thirdSeen, 'n=again')?.headers['cookie']).toBeUndefined()
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the five rows in Settings, saves a choice, applies it on the next request, accepts secure DNS live and offers a restart for the signal', async () => {
  const { app, chrome } = await launched({})
  try {
    const userData = await userDataOf(app)
    const page = await openSettings(app, chrome)
    for (const id of ['cookies', 'global-privacy-control', 'do-not-track', 'https-only', 'secure-dns']) expect(await page.locator(`#row-${id}`).count()).toBe(1)
    expect(await page.locator('#row-cookies').evaluate((row) => row.parentElement?.previousElementSibling?.textContent ?? '')).toBe('Connections and tracking')
    expect(await page.locator('#row-cookies').evaluate((row) => row.parentElement?.querySelectorAll('.row').length)).toBe(5)
    expect(await page.locator('#row-cookies option').allTextContents()).toEqual(['Allow all cookies', 'Block third-party cookies'])
    expect(await page.locator('#row-secure-dns option').allTextContents()).toEqual(['Off (use this computer\'s DNS)', 'Automatic (use secure DNS when the provider offers it)', 'Cloudflare (1.1.1.1)', 'Quad9 (9.9.9.9)'])
    await page.evaluate(() => { document.querySelector('.group-label')?.scrollIntoView() })
    await shoot(page, 'settings-privacy-rows')

    await page.locator('#row-do-not-track input[type=checkbox]').click()
    expect(await page.locator('#row-global-privacy-control-restart').count()).toBe(0)
    await page.locator('#row-global-privacy-control input[type=checkbox]').click()
    expect(await waitFor(() => savedSetting(userData, 'privacy.globalPrivacyControl') === false)).toBe(true)
    expect(await page.locator('#row-global-privacy-control-restart').count()).toBe(1)
    await page.locator('#row-secure-dns select').selectOption('cloudflare')
    await page.locator('#row-cookies select').selectOption('blockThirdParty')
    expect(await waitFor(() => savedSetting(userData, 'privacy.doNotTrack') === true && savedSetting(userData, 'privacy.secureDns') === 'cloudflare' && savedSetting(userData, 'privacy.cookies') === 'blockThirdParty')).toBe(true)

    await chrome.click('#new-tab')
    await visit(chrome, `http://127.0.0.1:${String(plainPort)}/after`)
    expect(await waitFor(() => hasSeen(plainSeen, '/after'))).toBe(true)
    expect(seenWith(plainSeen, '/after')?.headers['dnt']).toBe('1')
    // Global Privacy Control is read when Orivon starts, so turning it off here leaves this run sending it.
    expect(seenWith(plainSeen, '/after')?.headers['sec-gpc']).toBe('1')
    expect(mainOutput(app)).not.toContain('could not configure secure DNS')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('upgrades a named http address, offers the way through when that fails, and never touches the loopback fixtures', async () => {
  const { app, chrome } = await launched({ 'privacy.httpsOnly': true, 'privacy.secureDns': 'cloudflare' })
  const plainUrl = `http://127.0.0.1:${String(plainPort)}/ok`
  const sheet = async (): Promise<Page> => {
    expect(await waitFor(async () => await popoverShown(app, 'overlay=https-warning'))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=https-warning') && !w.isClosed()))).toBe(true)
    const page = app.windows().filter((w) => w.url().includes('overlay=https-warning') && !w.isClosed()).at(-1) as Page
    await page.waitForSelector('.https-card button')
    return page
  }
  try {
    // A loopback fixture loads as it always did: nothing is upgraded, nothing is asked.
    await visit(chrome, plainUrl)
    expect((await waitForTab(chrome, { address: plainUrl })).ok).toBe(true)
    expect(hasSeen(plainSeen, '/ok')).toBe(true)
    expect(await popoverShown(app, 'overlay=https-warning')).toBe(false)

    // A named host is sent to https, which nothing answers: the sheet appears over the tab.
    await visit(chrome, `http://down.test/first`)
    let warning = await sheet()
    expect(await warning.locator('.sheet-title').textContent()).toBe('This site does not support a secure connection')
    expect(await warning.locator('.origin').textContent()).toBe('down.test')
    expect(await warning.locator('.https-continue').textContent()).toBe('Continue to the HTTP site')
    expect(await warning.locator('.btn.primary').textContent()).toBe('Go back')
    expect(await warning.evaluate(() => document.activeElement?.textContent)).toBe('Go back')
    expect(hasSeen(plainSeen, '/first')).toBe(false)
    await shoot(warning, 'https-warning')

    // Go back returns to the page before.
    await warning.click('.btn.primary').catch((error: unknown) => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error })
    expect((await waitForTab(chrome, { address: plainUrl })).ok).toBe(true)
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=https-warning')))).toBe(true)

    // Escape is the same answer.
    await visit(chrome, `http://down.test/second`)
    warning = await sheet()
    // The sheet's view is destroyed by the answer, so the key press can lose its target: expected, not a failure.
    await warning.keyboard.press('Escape').catch((error: unknown) => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error })
    expect((await waitForTab(chrome, { address: plainUrl })).ok).toBe(true)

    // Continue opens the http page, and the host is not asked about again.
    await visit(chrome, `http://up.test/third`)
    warning = await sheet()
    await warning.click('.https-continue').catch((error: unknown) => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error })
    expect(await waitFor(() => hasSeen(plainSeen, '/third'))).toBe(true)
    expect(seenWith(plainSeen, '/third')?.headers['host']).toBe('up.test')
    expect((await waitForTab(chrome, { title: 'plain /third' })).ok).toBe(true)
    await visit(chrome, `http://up.test/fourth`)
    expect(await waitFor(() => hasSeen(plainSeen, '/fourth'))).toBe(true)
    expect(await popoverShown(app, 'overlay=https-warning')).toBe(false)

    // The other host is still not exempt.
    await visit(chrome, `http://down.test/fifth`)
    await sheet()
    expect(hasSeen(plainSeen, '/fifth')).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('leaves a named host with an explicit port alone, since port 443 is usually another service', async () => {
  const { app, chrome } = await launched({ 'privacy.httpsOnly': true })
  try {
    await visit(chrome, `http://down.test:8080/kept`)
    expect(await waitFor(() => hasSeen(plainSeen, '/kept'))).toBe(true)
    expect((await waitForTab(chrome, { title: 'plain /kept' })).ok).toBe(true)
    expect(await popoverShown(app, 'overlay=https-warning')).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('explains an upgraded address that fails on its certificate with the HTTPS sheet and its way through, not the certificate sheet', async () => {
  const { app, chrome } = await launched({ 'privacy.httpsOnly': true })
  try {
    await visit(chrome, 'http://selfsigned.test/page')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=https-warning'), 20_000)).toBe(true)
    const warning = app.windows().find((w) => w.url().includes('overlay=https-warning')) as Page
    await warning.waitForSelector('.https-continue')
    expect(await warning.locator('.https-continue').textContent()).toBe('Continue to the HTTP site')
    // The certificate sheet never took the place: one explanation, with the way through.
    expect(await popoverShown(app, 'overlay=cert-error')).toBe(false)
    await shoot(warning, 'https-warning-certificate')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
