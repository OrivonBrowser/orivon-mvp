// A routed app's page that opens an address outside the app's own sessions asks the person first, each time, whether the
// page goes through their tunnel or directly. The fixture app is served from the loader's cache and switched on in
// Settings. Its page opens a website whose name the SOCKS5 fixture knows and a decoy on the same port on loopback also
// answers (the browser resolves that name to loopback, as this machine would answer an unknown one): a page that went
// through the tunnel shows the real server's title and the decoy sees nothing, a page that went direct shows the decoy's.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-routed-leaving.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { activeTabInfo, delay, tabViews, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { serveApp } from '../node-runtime/pinned-app.js'

const ORIGIN = 'https://routed-leaving-e2e.orivon.test'
const OTHER = 'https://routed-leaving-other-e2e.orivon.test'
const SITE_NAME = 'site.socks.test'
const SETTINGS_URL_PREFIX = 'orivon://settings'
const switchOf = (name: string): string => `.app-card:has-text("${name}") .app-route .switch`

const APP_HTML = `<!doctype html><title>routed leaving</title><body>
<a id="same" href="/other.html">same origin</a>
<button id="open">open</button><button id="navigate">navigate</button><button id="blob">blob</button>
<script src="/app.js"></script></body>`
const APP_SCRIPT = `
document.getElementById('open').addEventListener('click', () => {
  const opened = window.open(window.__target)
  window.__opened = opened === null ? 'null' : 'window'
})
document.getElementById('blob').addEventListener('click', () => {
  const page = new Blob(['<!doctype html><title>blob hop</title><meta http-equiv="refresh" content="0;url=' + window.__target + '">'], { type: 'text/html' })
  location.href = URL.createObjectURL(page)
})
document.getElementById('navigate').addEventListener('click', () => { location.href = window.__target })
`
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

let dir: string
let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let appPage: Page
let sitePort = 0
let decoyHits = 0
const cleanups: Array<() => Promise<void> | void> = []

const siteUrl = (path = '/'): string => `http://${SITE_NAME}:${String(sitePort)}${path}`

async function listen (title: string, onHit?: () => void): Promise<{ port: number, close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    onHit?.()
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>${title}</title><body>${title}<button id="popup" onclick="window.open('/two')">popup</button></body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  }
}

/** The decoy has to hold the port the SOCKS fixture names, so the port is the decoy's and the real server takes any. */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-leaving-e2e-'))
  const decoy = await listen('direct', () => { decoyHits += 1 })
  sitePort = decoy.port
  const real = await listen('proxied')
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${SITE_NAME}:${String(sitePort)}`]: { host: '127.0.0.1', port: real.port } } })
  cleanups.push(() => decoy.close(), () => real.close(), async () => { await socks.close() }, () => { rmSync(dir, { recursive: true, force: true }) })

  const launched = await launchShell({
    // This rule replaces the hermetic one: the site's name reaches loopback (the decoy) if a request is not sent to the proxy, everything else is refused.
    args: [`--host-resolver-rules=MAP ${SITE_NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
  app = launched.app
  chrome = launched.chrome
  await stubNativeDialogs(app)

  for (const [origin, name] of [[ORIGIN, 'routed-leaving-e2e'], [OTHER, 'routed-leaving-other-e2e']] as const) {
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: `app.orivon.behaviour.${name}`,
      name,
      version: '1.0.0',
      entry: 'index.html',
      capabilities: { net: { tcp: { connect: ['nothing.socks.test:9'] } } }
    }
    const served = await serveApp(app, origin, manifest, 'tcp.connect', {
      '/index.html': encode(APP_HTML),
      '/other.html': encode('<!doctype html><title>same origin page</title><body>same origin page</body>'),
      '/app.js': encode(APP_SCRIPT)
    }, ['nothing.socks.test:9'])
    expect(served).toEqual({ granted: true, registered: true })
  }
  await switchRoute('routed-leaving-e2e', true)
  appPage = await openApp()
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await noNativeDialogs(app).catch(() => [])).toEqual([])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The page of the tab in front at `url`: a tab behind it may show the same address, and only the one in front is painted. */
async function frontPage (url: string): Promise<Page | undefined> {
  for (const page of tabViews(app, chrome)) {
    if (page.url() !== url || page.isClosed()) continue
    if (await page.evaluate(() => document.visibilityState).catch(() => 'hidden') === 'visible') return page
  }
  return undefined
}

async function openApp (url = `${ORIGIN}/`): Promise<Page> {
  // Typed again at the address it is on, the tab would reload and end a question asked meanwhile.
  const here = await frontPage(url)
  if (here !== undefined && (await activeTabInfo(chrome)).address === url) return here
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
  expect(await waitFor(async () => await frontPage(url) !== undefined)).toBe(true)
  const page = await frontPage(url) as Page
  await page.waitForLoadState('load')
  await page.waitForSelector('#open')
  return page
}

async function openSettings (): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/apps') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(SETTINGS_URL_PREFIX)))).toBe(true)
  return app.windows().find((w) => w.url().startsWith(SETTINGS_URL_PREFIX)) as Page
}

async function switchRoute (name: string, on: boolean): Promise<void> {
  const settings = await openSettings()
  await settings.waitForSelector(switchOf(name))
  const checked = async (): Promise<boolean> => await settings.locator(`${switchOf(name)} input`).isChecked()
  if ((await checked()) !== on) await settings.locator(switchOf(name)).click()
  expect(await waitFor(async () => (await checked()) === on)).toBe(true)
  await delay(500)
}

const proxied = (): number => socks.requests.filter((request) => request.destination === SITE_NAME && request.port === sitePort).length

/** A press by the person: the pointer moves to the element and clicks, which is the input a pop-up blocker looks for. */
async function pressInPage (page: Page, selector: string): Promise<void> {
  const box = await page.evaluate((query) => {
    const rect = document.querySelector(query)?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, selector)
  expect(box, `${selector} is on the page`).not.toBeNull()
  await page.mouse.click((box as { x: number }).x, (box as { y: number }).y)
}

/** Starts an open from the app's page by pressing its own button. A view under xvfb never reports itself stable to Playwright's pointer, so the press is the page's own `click()`. */
async function clickOpen (button: 'open' | 'navigate' | 'blob', target: string): Promise<void> {
  await appPage.evaluate((address) => { (window as unknown as { __target: string }).__target = address }, target)
  await appPage.evaluate((id) => { document.getElementById(id)?.click() }, button)
}

/** The tab whose address bar shows `address` is the active one and has loaded `title`. */
async function expectTab (address: string, title: string): Promise<Page> {
  expect((await waitForTab(chrome, { address })).ok, `the active tab shows ${address}`).toBe(true)
  expect(await waitFor(async () => await frontPage(address) !== undefined)).toBe(true)
  const page = await frontPage(address) as Page
  expect(await waitFor(async () => (await page.title()) === title), `the page says ${title}`).toBe(true)
  return page
}

const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

it('[app:routed-app-asks-before-opening-a-website] asks, in the window, whether the page goes through the tunnel or directly, and a same-origin address asks nothing', async () => {
  const before = (await tabIds(chrome)).length
  await appPage.evaluate(() => { document.getElementById('same')?.click() })
  await expectTab(`${ORIGIN}/other.html`, 'same origin page')
  expect(await questionGone(app), 'a navigation inside the app asks nothing').toBe(true)
  appPage = await openApp()

  await clickOpen('open', siteUrl())
  const panel = await waitQuestion(app)
  const said = await readQuestion(panel)
  expect(said.message).toBe(`${ORIGIN} wants to open http://${SITE_NAME}:${String(sitePort)}.`)
  expect(said.detail).toBe('Your tunnel is on for this app. Open the page through your tunnel, or directly?')
  expect([...said.buttons].sort()).toEqual(['Cancel', 'Directly', 'Through my tunnel'])
  expect((await tabIds(chrome)).length, 'nothing opened while the question is open').toBe(before)
  expect(proxied() + decoyHits).toBe(0)

  // Cancel: nothing opens, nothing arrives anywhere, and window.open said null.
  await answerQuestion(app, 'Cancel')
  expect(await waitFor(async () => await questionGone(app))).toBe(true)
  await delay(1000)
  expect((await tabIds(chrome)).length).toBe(before)
  expect(proxied() + decoyHits, 'a cancelled open sends nothing').toBe(0)
  expect(await appPage.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toBe('null')
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] "Through my tunnel" opens the page in a temporary session that goes through the tunnel and keeps nothing', async () => {
  await clickOpen('open', siteUrl('/one'))
  await answerQuestion(app, 'Through my tunnel')
  const page = await expectTab(siteUrl('/one'), 'proxied')
  expect(proxied(), 'the proxy was asked for the site').toBeGreaterThan(0)
  expect(decoyHits, 'nothing reached the decoy').toBe(0)
  const first = socks.requests.filter((request) => request.destination === SITE_NAME).at(-1)?.userId
  expect(first, 'it signed in to the proxy with a user name of its own').toBeDefined()

  const session = await app.evaluate(({ webContents }, address) => {
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === address)
    return contents === undefined ? null : { inMemory: contents.session.storagePath === null || contents.session.storagePath === undefined, webrtc: contents.getWebRTCIPHandlingPolicy() }
  }, siteUrl('/one'))
  expect(session, 'WebRTC cannot leave the proxy, and the session is in memory').toEqual({ inMemory: true, webrtc: 'disable_non_proxied_udp' })

  // Its site-info popover says so.
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-state').textContent()).toBe('This page goes through your tunnel, and nothing it stores is kept once its last tab is closed.')
  expect(await popover.locator('#tunnel-switch-socks5').isDisabled(), 'the page does not choose its tunnel here').toBe(true)
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(400)

  // Its own links and popups stay in the session, without asking again.
  await pressInPage(page, '#popup')
  await expectTab(siteUrl('/two'), 'proxied')
  expect(await questionGone(app), 'a page in the temporary session asks nothing').toBe(true)
  expect(decoyHits).toBe(0)

  // A second page opened through the proxy gets credentials of its own: Tor gives it other circuits.
  appPage = await openApp()
  await clickOpen('open', siteUrl('/three'))
  await answerQuestion(app, 'Through my tunnel')
  await expectTab(siteUrl('/three'), 'proxied')
  const second = socks.requests.filter((request) => request.destination === SITE_NAME).at(-1)?.userId
  expect(second).not.toBe(first)
  expect(decoyHits).toBe(0)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] "Directly" opens the page as it would with no route, and the tunnel sees nothing', async () => {
  appPage = await openApp()
  const asked = proxied()
  await clickOpen('open', siteUrl('/direct'))
  await answerQuestion(app, 'Directly')
  await expectTab(siteUrl('/direct'), 'direct')
  expect(decoyHits, 'it reached the site by itself').toBeGreaterThan(0)
  expect(proxied(), 'the proxy was not asked').toBe(asked)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] a navigation of the app\'s own tab asks too: Escape stays, "Through my tunnel" moves the same tab, and Back returns to the app', async () => {
  appPage = await openApp()
  const tabs = (await tabIds(chrome)).length
  const asked = proxied()
  await clickOpen('navigate', siteUrl('/nav'))
  const panel = await waitQuestion(app)
  await panel.waitForSelector('.q:not(.arming)')
  // The panel closes on the key, so its page may be gone before the press settles.
  await panel.keyboard.press('Escape').catch((error: unknown) => { if (!/closed|destroyed/.test(String(error))) throw error })
  expect(await waitFor(async () => await questionGone(app))).toBe(true)
  await delay(1000)
  expect((await activeTabInfo(chrome)).address, 'Escape leaves the tab on the app').toBe(`${ORIGIN}/`)
  expect(proxied()).toBe(asked)

  await clickOpen('navigate', siteUrl('/nav'))
  await answerQuestion(app, 'Through my tunnel')
  await expectTab(siteUrl('/nav'), 'proxied')
  expect((await tabIds(chrome)).length, 'the app\'s own tab moved; no tab was added').toBe(tabs)
  const hitsNow = decoyHits

  await chrome.click('#back')
  expect((await waitForTab(chrome, { address: `${ORIGIN}/` })).ok).toBe(true)
  await chrome.click('#forward')
  await expectTab(siteUrl('/nav'), 'proxied')
  expect(decoyHits, 'Forward onto the page opened through the proxy goes through it again').toBe(hitsNow)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] another installed app whose route is off is offered the tunnel too, and the switch turns on', async () => {
  appPage = await openApp()
  await clickOpen('open', `${OTHER}/`)
  const panel = await waitQuestion(app)
  const said = await readQuestion(panel)
  expect([...said.buttons].sort()).toEqual(['Cancel', 'Directly', `Use my tunnel for ${OTHER.replace('https://', '')} too`])
  await answerQuestion(app, `Use my tunnel for ${OTHER.replace('https://', '')} too`)
  await expectTab(`${OTHER}/`, 'routed leaving')

  const settings = await openSettings()
  await settings.waitForSelector(switchOf('routed-leaving-other-e2e'))
  expect(await settings.locator(`${switchOf('routed-leaving-other-e2e')} input`).isChecked(), 'the other app\'s switch is on').toBe(true)

  // With its route on, opening it from the routed app asks nothing.
  appPage = await openApp()
  await clickOpen('open', `${OTHER}/other.html`)
  await expectTab(`${OTHER}/other.html`, 'same origin page')
  expect(await questionGone(app)).toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] a document the app made for itself, with no web address, asks as the app does', async () => {
  appPage = await openApp()
  const asked = proxied()
  const hits = decoyHits
  await clickOpen('blob', siteUrl('/blob'))
  const panel = await waitQuestion(app)
  expect((await readQuestion(panel)).message).toBe(`${ORIGIN} wants to open http://${SITE_NAME}:${String(sitePort)}.`)
  await answerQuestion(app, 'Cancel')
  expect(await waitFor(async () => await questionGone(app))).toBe(true)
  await delay(1000)
  expect(proxied(), 'nothing was sent to the proxy').toBe(asked)
  expect(decoyHits, 'and nothing went direct').toBe(hits)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] a page Orivon loads itself (ipfs://) is asked about with no tunnel button, and Cancel loads nothing', async () => {
  appPage = await openApp()
  const tabs = (await tabIds(chrome)).length
  const asked = proxied()
  const hits = decoyHits
  await clickOpen('navigate', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/')
  const panel = await waitQuestion(app)
  const said = await readQuestion(panel)
  expect(said.message).toBe(`${ORIGIN} wants to open ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.`)
  expect(said.detail).toBe('Orivon loads this page itself, so it cannot go through your tunnel yet.')
  expect([...said.buttons].sort()).toEqual(['Cancel', 'Directly'])
  await panel.waitForSelector('.q:not(.arming)')
  await shoot(app, chrome, panel, 'routed-leaving-served')
  await answerQuestion(app, 'Cancel')
  expect(await waitFor(async () => await questionGone(app))).toBe(true)
  await delay(1000)
  expect((await activeTabInfo(chrome)).address, 'the tab stays on the app').toBe(`${ORIGIN}/`)
  expect((await tabIds(chrome)).length).toBe(tabs)
  expect(proxied(), 'nothing was sent to the proxy').toBe(asked)
  expect(decoyHits, 'and nothing went direct').toBe(hits)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:routed-app-asks-before-opening-a-website] while a question from the app is open its next request is cancelled unasked, and it is asked again once answered', async () => {
  appPage = await openApp()
  const tabs = (await tabIds(chrome)).length
  const asked = proxied()
  const hits = decoyHits
  await clickOpen('open', siteUrl('/first'))
  await waitQuestion(app)
  await clickOpen('open', siteUrl('/second'))
  expect(await appPage.evaluate(() => (window as unknown as { __opened?: string }).__opened), 'the second window.open said null').toBe('null')
  await answerQuestion(app, 'Cancel')
  expect(await waitFor(async () => await questionGone(app))).toBe(true)
  await delay(1000)
  expect(await questionGone(app), 'the cancelled request raised no question of its own').toBe(true)
  expect((await tabIds(chrome)).length).toBe(tabs)
  expect(proxied() + decoyHits, 'nothing was sent').toBe(asked + hits)

  // Nothing is remembered: the same request is asked about again.
  await clickOpen('open', siteUrl('/second'))
  await waitQuestion(app)
  await answerQuestion(app, 'Cancel')
  expect(await waitFor(async () => await questionGone(app))).toBe(true)
}, 3 * QA_TEST_TIMEOUT_MS)
