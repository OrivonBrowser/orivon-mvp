// A page navigation that moves the tab into another session (an installed app's own session, or the profile of a tunnel)
// is stopped and issued again there. The new request carries the referrer Chromium would have sent for the navigation,
// never more and, where the page cannot say, none: the policy of the document (its `Referrer-Policy` header or a
// `<meta name="referrer">`), the `rel="noreferrer"` and `referrerpolicy` of the link, a form's own rules, and the
// difference between a link, a script's `location.assign`, a form and a `window.open`. Every case asserts what the
// landing page reads as `document.referrer`; the tunnel case also asserts the `Referer` header the website received.
//
// Two launches: a `.eth` page linking to an installed `.eth` app (the app's own session), and a website linking to a
// website that has a tunnel of its own (the tunnel's profile). The tunnel's destination answers only through the SOCKS5
// fixture; the same name and port on the direct side answers a page that fails the case.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/tabs/e2e-navigation-referrer.test.ts
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { originHash } from '../../src/broker/grants/origin-hash.js'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, closeElectronApp } from '../support/e2e-helpers.js'
import { launchShell } from '../support/qa-helpers.js'
import { answerEveryQuestion, noNativeDialogs, stubNativeDialogs } from '../support/question-support.js'
import { delay, findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type Policy = 'default' | 'strict-origin' | 'no-referrer' | 'unsafe-url'
/** A page: one per policy, and `loading`, the default policy with an image that never finishes loading, so the page is still loading when its link is pressed. */
type Source = Policy | 'loading'
type Trigger = 'link' | 'assign' | 'form' | 'open' | 'noreferrer' | 'attribute' | 'forced'

/** One thing the person does on a page, and what the landing page must read as its referrer. */
interface Case { readonly page: Source, readonly trigger: Trigger }

const POLICIES = ['default', 'strict-origin', 'no-referrer', 'unsafe-url'] as const

const SELECTOR: Record<Trigger, string> = { link: '#link', assign: '#assign', form: '#submit', open: '#open', noreferrer: '#noreferrer', attribute: '#attribute', forced: '#forced' }

const CASES: Case[] = [
  ...POLICIES.flatMap((page) => (['link', 'assign', 'form', 'open'] as const).map((trigger) => ({ page, trigger }))),
  // rel="noreferrer" and the link's own referrerpolicy beat the document's, in both directions.
  { page: 'default', trigger: 'noreferrer' },
  { page: 'unsafe-url', trigger: 'noreferrer' },
  { page: 'default', trigger: 'attribute' },
  { page: 'no-referrer', trigger: 'forced' }
]

/** What Chromium sends for each case from `pageUrl` (https to https, or http to http, across origins), written out by hand. */
function expectedReferrer (c: Case, pageUrl: string): string {
  const origin = `${new URL(pageUrl).origin}/`
  const bySheet = { default: origin, loading: origin, 'strict-origin': origin, 'no-referrer': '', 'unsafe-url': pageUrl }
  if (c.trigger === 'noreferrer' || c.trigger === 'attribute') return ''
  if (c.trigger === 'forced') return pageUrl
  return bySheet[c.page]
}

const caseId = (c: Case): string => `${c.page}-${c.trigger}`

/** The page a case starts on: every thing a person can press, and the policy as a `<meta>` where the case wants one. */
function sourcePage (page: Source, landing: string): string {
  const meta = page === 'default' || page === 'loading' ? '' : `<meta name="referrer" content="${page}">`
  const to = (trigger: Trigger): string => `${landing}${landing.includes('?') ? '&' : '?'}via=${page}-${trigger}`
  return `<!doctype html><meta charset="utf-8">${meta}<title>source ${page}</title><body>${page === 'loading' ? '<img src="/hang.png" alt="">' : ''}
<a id="link" href="${to('link')}">link</a>
<a id="noreferrer" rel="noreferrer" href="${to('noreferrer')}">noreferrer</a>
<a id="attribute" referrerpolicy="no-referrer" href="${to('attribute')}">attribute</a>
<a id="forced" referrerpolicy="unsafe-url" href="${to('forced')}">forced</a>
<button id="assign" type="button">assign</button><button id="open" type="button">open</button>
<form action="${landing}" method="get"><input type="hidden" name="via" value="${page}-form"><button id="submit" type="submit">submit</button></form>
<script src="/${page}.js"></script></body>`
}

function sourceScript (page: Source, landing: string): string {
  const to = (trigger: Trigger): string => `${landing}${landing.includes('?') ? '&' : '?'}via=${page}-${trigger}`
  return `document.getElementById('assign').addEventListener('click', () => { location.assign(${JSON.stringify(to('assign'))}) })
document.getElementById('open').addEventListener('click', () => { window.open(${JSON.stringify(to('open'))}) })`
}

interface Landed { readonly referrer: string, readonly sharedSession: boolean }

/** The newest page at `url` once it has loaded, read from main: Playwright does not always attach to a view swapped in late. */
async function landedAt (app: ElectronApplication, url: string): Promise<Landed | undefined> {
  return await app.evaluate(async ({ webContents, session }, target) => {
    const found = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === target && !contents.isLoading()).sort((a, b) => b.id - a.id)[0]
    if (found === undefined) return undefined
    return { referrer: await found.executeJavaScript('document.referrer') as string, sharedSession: found.session === session.defaultSession }
  }, url).catch(() => undefined)
}

/** Closes every tab but `keep`, so the next address typed goes into the tab the case started in. */
async function onlyTab (chrome: Page, keep: string): Promise<void> {
  for (const id of await tabIds(chrome)) {
    if (id !== keep) await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, id)
  }
  expect(await waitFor(async () => (await tabIds(chrome)).length === 1), 'only the opener is left').toBe(true)
}

interface Outcome { readonly referrer: string, readonly header?: string, readonly leftTheSharedSession: boolean }

/** Opens the case's page, presses its trigger and reads what the landing page was told. */
async function drive (app: ElectronApplication, chrome: Page, first: string, c: Case, sourceUrl: string, landingUrl: string, open: (url: string) => Promise<Page>): Promise<Outcome> {
  const view = await open(sourceUrl)
  await view.click(SELECTOR[c.trigger], { noWaitAfter: true })
  let landed: Landed | undefined
  await waitFor(async () => { landed = await landedAt(app, landingUrl); return landed !== undefined }, 30_000)
  if (c.trigger === 'open') await onlyTab(chrome, first)
  return landed === undefined ? { referrer: 'no landing', leftTheSharedSession: false } : { referrer: (landed as Landed).referrer, leftTheSharedSession: !(landed as Landed).sharedSession }
}

// ---- The installed app: a `.eth` page links to a `.eth` app with a session of its own ------------------------------

const APP_ORIGIN = 'https://b.eth'
const MANIFEST = { orivonApiVersion: 0, id: 'eth.orivon.referrer-landing', name: 'Landing', version: '1.0.0', entry: 'index.html', assets: ['app.js'], capabilities: {} }
const INSTALLED_APP = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>landing</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>landing<script src="app.js"></script></body>',
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify(MANIFEST)
}

it('[app:navigation-keeps-the-referrer] a link, a script, a form and a popup from a .eth page into an installed .eth app carry the referrer Chromium would have sent', async () => {
  const pages: Record<string, string> = {}
  for (const page of POLICIES) {
    pages[`${page}.html`] = sourcePage(page, `${APP_ORIGIN}/`)
    pages[`${page}.js`] = sourceScript(page, `${APP_ORIGIN}/`)
  }
  const gateway = await startFixtureGateway({ a: pages, b: INSTALLED_APP })
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    app = await launchElectron({
      appPath: '.',
      args: [HERMETIC_RESOLVER],
      env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'a.eth': `ipfs://${gateway.roots['a']!}`, 'b.eth': `ipfs://${gateway.roots['b']!}` }), ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
    })
    const running = app
    await stubNativeDialogs(running)
    answerEveryQuestion(running)
    const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
    expect(listening, 'the verifier host is listening').toBe(true)
    expect(await waitFor(() => running.windows().length === 2)).toBe(true)
    const chrome = findChrome(running)
    const first = (await tabIds(chrome))[0] as string

    // Install the app: its address, then the pin the hint writes.
    const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    await clickAddressBarRetrying(chrome, `${APP_ORIGIN}/`)
    expect(await waitFor(() => existsSync(join(userData, 'apps', originHash(APP_ORIGIN), 'pin.json')), 30_000), 'the app installed').toBe(true)

    const open = async (url: string): Promise<Page> => {
      await clickAddressBarRetrying(chrome, url)
      expect(await waitFor(() => findViewShowing(running, chrome, url) !== undefined, 30_000), `${url} shows`).toBe(true)
      const view = findViewShowing(running, chrome, url) as Page
      await view.waitForLoadState('domcontentloaded')
      return view
    }

    const seen: Record<string, Outcome> = {}
    const wanted: Record<string, Outcome> = {}
    for (const c of CASES) {
      const sourceUrl = `https://a.eth/${c.page}.html`
      seen[caseId(c)] = await drive(running, chrome, first, c, sourceUrl, `${APP_ORIGIN}/?via=${caseId(c)}`, open)
      wanted[caseId(c)] = { referrer: expectedReferrer(c, sourceUrl), leftTheSharedSession: true }
    }
    expect(seen).toEqual(wanted)
    expect(await noNativeDialogs(running)).toEqual([])
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    await gateway.close()
  }
}, 12 * 60_000)

// ---- The tunnel: a website links to a website with a tunnel of its own ------------------------------------------------

const SOURCE_HOST = 'plain.socks.test'
const TUNNEL_HOST = 'tunnelled.socks.test'

interface Hosted { port: number, close: () => Promise<void> }

async function listen (answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<Hosted> {
  const server: Server = createServer(answer)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

it('[app:navigation-keeps-the-referrer] a link, a script, a form and a popup from a website into a website with a tunnel of its own carry the referrer Chromium would have sent, in the Referer header too', async () => {
  const received: Array<{ url: string, referer: string | undefined }> = []
  let decoyPort = 0
  const landing = (): string => `http://${TUNNEL_HOST}:${String(decoyPort)}/land`
  const decoy = await listen((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0]
    const url = new URL(request.url ?? '/', 'http://x')
    response.setHeader('cache-control', 'no-store')
    if (host === SOURCE_HOST) {
      if (url.pathname === '/hang.png') return
      const page = url.pathname.slice(1).replace(/\.js$/, '') as Source
      if (![...POLICIES, 'loading'].includes(page)) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html' })
      response.end(url.pathname.endsWith('.js') ? sourceScript(page, landing()) : sourcePage(page, landing()))
      return
    }
    // The tunnelled website's name on the direct side: a request here skipped the tunnel.
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>direct</title><body>direct</body>')
  })
  decoyPort = decoy.port
  const real = await listen((request, response) => {
    received.push({ url: request.url ?? '', referer: request.headers['referer'] })
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>landed</title><body>landed</body>')
  })
  const socks = await startSocks5Fixture({ preferAuth: true, names: { [`${TUNNEL_HOST}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } } })
  const tunnelledOrigin = `http://${TUNNEL_HOST}:${String(decoy.port)}`
  let launched: Awaited<ReturnType<typeof launchShell>> | undefined
  try {
    launched = await launchShell({
      args: [`--host-resolver-rules=MAP ${SOURCE_HOST} 127.0.0.1, MAP ${TUNNEL_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
      seedProfile: async (userDataDir) => {
        writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
        writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [tunnelledOrigin], via: { [tunnelledOrigin]: 'socks5' }, off: [], apart: [], apartProxy: [], apartDirect: [] }))
      }
    })
    const { app, chrome } = launched
    const first = (await tabIds(chrome))[0] as string
    const open = async (url: string): Promise<Page> => {
      await clickAddressBarRetrying(chrome, url)
      expect(await waitFor(() => findViewShowing(app, chrome, url) !== undefined, 30_000), `${url} shows`).toBe(true)
      const view = findViewShowing(app, chrome, url) as Page
      await view.waitForLoadState('domcontentloaded')
      return view
    }

    const seen: Record<string, Outcome> = {}
    const wanted: Record<string, Outcome> = {}
    for (const c of [...CASES, { page: 'loading', trigger: 'link' } as const]) {
      const sourceUrl = `http://${SOURCE_HOST}:${String(decoy.port)}/${c.page}`
      const outcome = await drive(app, chrome, first, c, sourceUrl, `${landing()}?via=${caseId(c)}`, open)
      await delay(200)
      const header = received.find((one) => one.url === `/land?via=${caseId(c)}`)
      seen[caseId(c)] = { ...outcome, header: header === undefined ? 'no request' : header.referer ?? '' }
      const expected = expectedReferrer(c, sourceUrl)
      wanted[caseId(c)] = { referrer: expected, header: expected, leftTheSharedSession: true }
    }
    expect(seen).toEqual(wanted)
    expect(socks.requests.some((request) => request.destination === TUNNEL_HOST), 'the tunnelled website was reached through the tunnel').toBe(true)
  } finally {
    if (launched !== undefined) await closeElectronApp(launched.app)
    await socks.close()
    await real.close()
    await decoy.close()
  }
}, 12 * 60_000)
