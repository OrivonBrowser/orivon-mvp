// "Keep tunneled sites separate" (Settings, Tunnels) is on by default: a site in a tunnel profile has cookies of its own. Turned off,
// the cookies of the sites a person opens in a tunnelled tab are kept the same in the profile and in normal browsing, both ways, so a
// tab that carries a tunnel choice is signed in to the accounts normal browsing is signed in to, with the route of the tab unchanged
// (the site is reached through the SOCKS5 fixture, never directly). The cookies of a third party the page embeds are not shared.
// A site is added by a navigation the person started (the address bar) or by one that has committed at it, never by a tracker a page
// bounces through (a redirect, a script, a popup). Turned on again, the profiles' copies are cleared and normal browsing keeps its
// own, also when the app was closed before the clear was done. The switch is the real one in Settings; cookies are read from each
// session in the main process.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/sites/e2e-tunnel-shared-sign-ins.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visitWithoutPage } from '../support/qa-helpers.js'
import { activeTabInfo, delay, waitFor } from '../support/smoke-helpers.mjs'

const SITE = 'bank.socks.test'
/** A host of another registrable domain: the third party a page embeds. */
const TRACKER = 'ads.cdn-tracker.test'
const RECORD = 'cookie-mirror.json'
const PROXY_PROFILE = 'persist:proxy-profile'
const DIRECT_PROFILE = 'persist:direct-profile'
const SWITCH = '#row-route-separate-sign-ins input[type=checkbox]'
type Choice = 'socks5' | 'direct'

/** `via` is the route a request took: the SOCKS5 fixture's (`tunnel`) or straight to the host the resolver maps (`direct`). */
interface Seen { host: string, path: string, cookie: string, via: 'tunnel' | 'direct' }

let socks: Socks5Fixture
let dir: string
let spki = ''
const ports = { real: 0, decoy: 0 }
const servers: Server[] = []
const seen: Seen[] = []
let visits = 0
let minted = 0
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** The page a request for `path` gets: the cookies a site sets on sign-in, sign-out and in a tunnelled tab. */
function answer (via: Seen['via'], request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  const host = (request.headers.host ?? '').split(':')[0]
  seen.push({ host: host ?? '', path, cookie: request.headers.cookie ?? '', via })
  if (host === TRACKER) {
    minted += 1
    const identity = `uid=minted-${String(minted)}; Path=/; Secure; SameSite=None; Max-Age=3600`
    const back = new URL(request.url ?? '/', 'https://x.test').searchParams.get('u')
    if (path === '/r' && back !== null) { response.writeHead(302, { location: back, 'cache-control': 'no-store', 'set-cookie': identity }).end(); return }
    if (path === '/landing') { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'set-cookie': identity }).end('<!doctype html><title>landing</title><body>landing</body>'); return }
    response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store', 'set-cookie': identity }).end(GIF)
    return
  }
  const bounce = `https://${TRACKER}:${String(ports.decoy)}/r?u=${encodeURIComponent(`https://${SITE}:${String(ports.decoy)}/landed`)}`
  if (path === '/to-tracker') { response.writeHead(302, { location: bounce, 'cache-control': 'no-store' }).end(); return }
  const headers: Record<string, string | string[]> = { 'content-type': 'text/html', 'cache-control': 'no-store' }
  if (path === '/login') headers['set-cookie'] = 'sid=signed-in; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600'
  if (path === '/tunnel-login') headers['set-cookie'] = 'tunnelled=yes; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'
  if (path === '/other-login') headers['set-cookie'] = 'other=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'
  if (path === '/logout') headers['set-cookie'] = 'sid=; Path=/; Secure; Max-Age=0'
  const embed = path === '/embed' ? `<img src="https://${TRACKER}:${String(ports.decoy)}/pixel.gif" width="1" height="1">` : ''
  // What a page does by itself: bounces through the tracker with a script, offers a link that opens one in a popup, or leaves for it.
  const script = path === '/bounce' ? `<script>location.href = ${JSON.stringify(bounce)}</script>` : path === '/leave' ? `<script>location.href = ${JSON.stringify(`https://${TRACKER}:${String(ports.decoy)}/landing`)}</script>` : ''
  const popup = path === '/popup' ? `<a id="pop" href=${JSON.stringify(bounce)} target="_blank">pop</a>` : ''
  response.writeHead(200, headers).end(`<!doctype html><title>${path}</title><body>${path}${embed}${popup}${script}</body>`)
}

/** An https site: a plain-http one lives in a profile kept in memory, which the mirror never touches. The page address names the decoy's port, so a request that skipped the tunnel lands on the decoy and is told apart. */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-shared-sign-ins-e2e-'))
  const tls = selfSigned(dir, [SITE, TRACKER])
  spki = tls.spki
  const make = async (via: Seen['via']): Promise<number> => {
    const hosted = createServer(tls, (request, response) => { answer(via, request, response) })
    await new Promise<void>((resolve) => { hosted.listen(0, '127.0.0.1', resolve) })
    servers.push(hosted)
    return (hosted.address() as AddressInfo).port
  }
  ports.real = await make('tunnel')
  ports.decoy = await make('direct')
  const reached = { host: '127.0.0.1', port: ports.real }
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${SITE}:${String(ports.decoy)}`]: reached, [`${TRACKER}:${String(ports.decoy)}`]: reached } })
}, 60_000)

afterAll(async () => {
  await socks.close()
  for (const hosted of servers) await new Promise<void>((resolve) => { hosted.close(() => { resolve() }); hosted.closeAllConnections() })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const urlOf = (path: string): string => { visits += 1; return `https://${SITE}:${String(ports.decoy)}${path}?n=${String(visits)}` }
/** How many requests reached the site by `via`; one connection through the tunnel carries many, so the fixture's own count of connections is no measure. */
const hits = (via: Seen['via']): number => seen.filter((one) => one.via === via).length
const lastCookie = (path: string, via: Seen['via']): string => seen.filter((one) => one.path === path && one.via === via).at(-1)?.cookie ?? '(no request)'
const requestsSeen = (): string => seen.map((one) => `${one.via} ${one.path} [${one.cookie}]`).join(' | ')

const settingsFor = (settings: Record<string, unknown>): string => JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, ...settings } })

/** A fresh profile, or the one `reuse` names (whose settings and record the test has put down). */
async function start (settings: Record<string, unknown> = {}, reuse?: string): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    args: [`--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP ${TRACKER} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`],
    ...(reuse === undefined
      ? { seedProfile: async (userDataDir: string) => { writeFileSync(join(userDataDir, 'settings.json'), settingsFor(settings)) } }
      : { reuseProfile: reuse })
  })
}

/** What the mirror has on disk, as the next start will read it. */
const recordOf = (profile: string): unknown => JSON.parse(readFileSync(join(profile, RECORD), 'utf8'))

/** Writes the cookies of both sessions to disk, so a launch on the same profile finds them. */
async function flushCookies (app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ session }) => {
    for (const target of [session.defaultSession, session.fromPartition('persist:proxy-profile')]) await target.cookies.flushStore()
  })
}

/** The profile folder of a launch, which must exist. */
const profileOf = (app: ElectronApplication): string => {
  const found = profileDirOf(app)
  if (found === undefined) throw new Error('the launcher did not report a profile directory')
  return found
}

const activeId = async (chrome: Page): Promise<string> => (await activeTabInfo(chrome)).activeId as string

/** Opens a tab that carries `choice` and leaves it in front. */
async function tabWith (app: ElectronApplication, chrome: Page, choice: Choice): Promise<string> {
  await chrome.click('#new-tab')
  const id = await activeId(chrome)
  const done = await app.evaluate((_electron, [tab, value]) => (globalThis as unknown as { __orivonDevTabTunnel?: { set: (tab: string, choice: string | null) => boolean } }).__orivonDevTabTunnel?.set(tab as string, value as string), [id, choice])
  expect(done, 'the test seam found the tab').toBe(true)
  return id
}

const activate = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { activateTab: (id: string) => void } }).orivonShell.activateTab(tab) }, id)
  expect(await waitFor(async () => await activeId(chrome) === id), 'the tab is in front').toBe(true)
}

/** The cookies of one session, read in the main process: the default session for `null`. */
async function cookiesIn (app: ElectronApplication, partition: string | null, name?: string): Promise<Array<Record<string, unknown>>> {
  return await app.evaluate(async ({ session }, [part, cookieName]) => {
    const target = part === null ? session.defaultSession : session.fromPartition(part)
    return await target.cookies.get(cookieName === null ? {} : { name: cookieName }) as unknown as Array<Record<string, unknown>>
  }, [partition, name ?? null] as const)
}

/** Types `url` in the address bar and waits for a page done loading at an address that starts with `landing`: where the navigation ends, after the bounces it makes on the way. */
async function visitUntil (app: ElectronApplication, chrome: Page, url: string, landing: string): Promise<void> {
  await clickAddressBarRetrying(chrome, url)
  expect(await waitFor(async () => await app.evaluate(({ webContents }, target) => webContents.getAllWebContents().some((wc) => wc.getURL().startsWith(target) && !wc.isLoading()), landing)), `a page loaded at ${landing}`).toBe(true)
}

/** Clicks the element `selector` of the page whose address contains `part` with real input, which is what lets a page open a window. */
async function clickWithInput (app: ElectronApplication, part: string, selector: string): Promise<void> {
  await app.evaluate(async ({ webContents }, [wanted, css]) => {
    const wc = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL().includes(wanted as string))
    if (wc === undefined) throw new Error(`no page at ${wanted as string}`)
    const at = await wc.executeJavaScript(`(() => { const box = document.querySelector(${JSON.stringify(css)}).getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } })()`) as { x: number, y: number }
    wc.sendInputEvent({ type: 'mouseMove', ...at })
    wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  }, [part, selector] as const)
}

/** What the tracker was sent by the requests to it from `from` on. */
const trackerSaw = (from: number): string[] => seen.slice(from).filter((one) => one.host === TRACKER).map((one) => one.cookie)

/** Moves the switch in Settings the way a person does, and leaves the tab that was in front in front. */
async function setSeparate (app: ElectronApplication, chrome: Page, on: boolean): Promise<void> {
  const before = await activeId(chrome)
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
  expect(await waitFor(() => app.windows().some((window) => window.url().startsWith('orivon://settings')))).toBe(true)
  const settings = app.windows().find((window) => window.url().startsWith('orivon://settings')) as Page
  await settings.waitForSelector(SWITCH)
  if (await settings.locator(SWITCH).isChecked() !== on) await settings.locator(SWITCH).click()
  expect(await waitFor(async () => await settings.locator(SWITCH).isChecked() === on), 'the switch shows its new state').toBe(true)
  await settings.close()
  await activate(chrome, before)
}

it('[tunnel profiles share sign-ins] separate by default; with the switch off a tunnelled tab is signed in to what normal browsing is for the site it opens, both ways, attributes kept, and not for a third party; on again, the profiles\' copies are cleared', async () => {
  const { app, chrome } = await start()
  try {
    const profile = profileOf(app)
    const normal = await activeId(chrome)
    await visitWithoutPage(app, chrome, urlOf('/login'))
    expect(await cookiesIn(app, null, 'sid'), 'normal browsing is signed in').toHaveLength(1)

    // Separate, as it is by default: the tunnelled tab is reached through the tunnel and does not send the sign-in.
    const tunnelled = await tabWith(app, chrome, 'socks5')
    const before = hits('tunnel')
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(hits('tunnel'), 'the site was reached through the tunnel').toBeGreaterThan(before)
    expect(lastCookie('/whoami', 'tunnel'), 'the tunnelled tab is not signed in').not.toContain('sid=')
    expect(await cookiesIn(app, PROXY_PROFILE), 'the profile holds nothing').toEqual([])

    // Off: nothing is copied until a tunnelled tab opens the site; then the profile receives the sign-in with its attributes before the page asks for it, still through the tunnel.
    await setSeparate(app, chrome, false)
    await delay(1500)
    expect(await cookiesIn(app, PROXY_PROFILE, 'sid'), 'a site no tunnelled tab has opened yet is not copied').toHaveLength(0)
    const direct = hits('direct')
    const through = hits('tunnel')
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(hits('tunnel'), 'the site was reached through the tunnel again').toBeGreaterThan(through)
    expect(hits('direct'), 'and not directly').toBe(direct)
    expect(lastCookie('/whoami', 'tunnel'), `the tunnelled tab is signed in to the same account (the site saw: ${requestsSeen()}; the profile holds: ${JSON.stringify(await cookiesIn(app, PROXY_PROFILE))})`).toContain('sid=signed-in')
    const copied = (await cookiesIn(app, PROXY_PROFILE, 'sid'))[0] as Record<string, unknown>
    expect(copied).toMatchObject({ value: 'signed-in', domain: SITE, hostOnly: true, httpOnly: true, secure: true, sameSite: 'lax', session: false, path: '/' })
    expect(copied['expirationDate'] as number, 'the expiry is the cookie\'s own').toBeGreaterThan(Date.now() / 1000)
    expect(await app.evaluate(({ webContents, session }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes('/whoami') && wc.session !== session.defaultSession)), 'the tab still lives in a session of its own').toBe(true)
    expect(recordOf(profile), 'the site is recorded for the profile').toEqual({ version: 1, domains: { 'proxy-profile': ['socks.test'] }, owed: false })

    // A third party the page embeds is not shared: its cookie stays where it was minted, in both directions.
    await visitWithoutPage(app, chrome, urlOf('/embed'))
    expect(await waitFor(async () => (await cookiesIn(app, PROXY_PROFILE, 'uid')).length === 1, 20_000), 'the embed ran in the tunnelled tab and was given its cookie').toBe(true)
    const profileUid = (await cookiesIn(app, PROXY_PROFILE, 'uid'))[0]?.['value']
    await app.evaluate(async ({ session }, tracker) => { await session.defaultSession.cookies.set({ url: tracker, name: 'uid', value: 'minted-in-normal-browsing', secure: true, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 3600 }) }, `https://${TRACKER}/`)
    await delay(2500)
    expect(await cookiesIn(app, null, 'uid'), 'the tracker\'s cookie did not reach normal browsing').toEqual([expect.objectContaining({ value: 'minted-in-normal-browsing' })])
    expect((await cookiesIn(app, PROXY_PROFILE, 'uid'))[0]?.['value'], 'nor did normal browsing\'s reach the profile').toBe(profileUid)

    // A cookie set in the tunnelled tab reaches normal browsing.
    await visitWithoutPage(app, chrome, urlOf('/tunnel-login'))
    expect(await waitFor(async () => (await cookiesIn(app, null, 'tunnelled')).length === 1, 20_000), 'a cookie of the tunnelled tab reached normal browsing').toBe(true)
    expect((await cookiesIn(app, null, 'tunnelled'))[0]).toMatchObject({ value: 'yes', hostOnly: true, httpOnly: true, sameSite: 'lax' })

    // A sign-out in normal browsing signs the tunnelled tab out.
    await activate(chrome, normal)
    await visitWithoutPage(app, chrome, urlOf('/logout'))
    expect(await waitFor(async () => (await cookiesIn(app, PROXY_PROFILE, 'sid')).length === 0, 20_000), 'the sign-out reached the profile').toBe(true)
    expect(await cookiesIn(app, null, 'sid')).toEqual([])

    // A profile this run had not made until now joins as it is made: its first page already has the sign-in.
    await visitWithoutPage(app, chrome, urlOf('/login'))
    await tabWith(app, chrome, 'direct')
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(lastCookie('/whoami', 'direct'), 'a profile made after the switch was moved starts with the cookies of the site it opens').toContain('sid=signed-in')
    expect(await cookiesIn(app, DIRECT_PROFILE, 'sid')).toHaveLength(1)

    // Sessions that are not profiles are left alone.
    expect(await cookiesIn(app, 'persist:app-0123456789abcdef'), 'an app\'s session is not mirrored').toEqual([])
    expect(await cookiesIn(app, 'tunnel-profile-memory'), 'a profile kept in memory is not mirrored').toEqual([])

    // On again: the profiles' copies of the site go, normal browsing keeps its own, and the tunnelled tab is signed out.
    await setSeparate(app, chrome, true)
    expect(await waitFor(async () => (await cookiesIn(app, PROXY_PROFILE, 'sid')).length === 0 && (await cookiesIn(app, DIRECT_PROFILE)).length === 0, 20_000), 'the profiles\' copies were cleared').toBe(true)
    expect((await cookiesIn(app, PROXY_PROFILE)).map((cookie) => cookie['name']), 'what the profile holds of third parties stays').toEqual(['uid'])
    expect((await cookiesIn(app, null)).map((cookie) => cookie['name']).sort(), 'normal browsing kept its cookies').toEqual(['sid', 'tunnelled', 'uid'])
    expect(await waitFor(() => JSON.stringify(recordOf(profile)) === JSON.stringify({ version: 1, domains: {}, owed: false }), 10_000), 'the record is empty again').toBe(true)
    await activate(chrome, tunnelled)
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(lastCookie('/whoami', 'tunnel'), 'the tunnelled tab is separate again').not.toContain('sid=')
    await visitWithoutPage(app, chrome, urlOf('/other-login'))
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(lastCookie('/whoami', 'tunnel'), 'the profile keeps a cookie its own tab was given').toContain('other=1')
    await delay(2000)
    expect(await cookiesIn(app, null, 'other'), 'a cookie set in a separate profile stays there').toEqual([])
  } finally {
    await closeElectron(app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)

it('[tunnel profiles share sign-ins] the site typed in the address bar is copied before its first request; a tracker a page bounces through (a redirect, a script, a popup) is not, and a site a page navigates to is added once it has loaded', async () => {
  const { app, chrome } = await start({ 'network.tunnel.separateSignIns': false })
  try {
    const profile = profileOf(app)
    const landed = `https://${SITE}:${String(ports.decoy)}/landed`
    const normalIdentity = 'minted-in-normal-browsing'
    await visitWithoutPage(app, chrome, urlOf('/login'))
    await app.evaluate(async ({ session }, [tracker, value]) => { await session.defaultSession.cookies.set({ url: tracker as string, name: 'uid', value: value as string, secure: true, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 3600 }) }, [`https://${TRACKER}/`, normalIdentity])
    await tabWith(app, chrome, 'socks5')

    // The address bar to a site: the person's own choice, copied before the first request asks for it.
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(lastCookie('/whoami', 'tunnel'), 'the first request of a navigation the person started sends the sign-in').toContain('sid=signed-in')
    expect(recordOf(profile)).toEqual({ version: 1, domains: { 'proxy-profile': ['socks.test'] }, owed: false })

    const bounced = async (label: string, from: number): Promise<void> => {
      const sent = trackerSaw(from)
      expect(sent.length, `${label}: the tracker was reached`).toBeGreaterThan(0)
      for (const cookie of sent) expect(cookie, `${label}: normal browsing's identity was not sent to the tracker`).not.toContain(normalIdentity)
      expect((await cookiesIn(app, PROXY_PROFILE, 'uid'))[0]?.['value'], `${label}: the profile holds the identity the tracker gave it`).toMatch(/^minted-\d+$/)
      expect(recordOf(profile), `${label}: the tracker is not in the scope`).toEqual({ version: 1, domains: { 'proxy-profile': ['socks.test'] }, owed: false })
    }

    // A redirect hop of a navigation the person started: the first hop is the site, the tracker is a hop after it.
    let from = seen.length
    await visitUntil(app, chrome, urlOf('/to-tracker'), landed)
    await bounced('a redirect through the tracker', from)

    // A page that sends its tab through the tracker with a script.
    from = seen.length
    await visitUntil(app, chrome, urlOf('/bounce'), landed)
    await bounced('a script bouncing through the tracker', from)

    // A popup a page opens into the tracker, which sends it back.
    await visitWithoutPage(app, chrome, urlOf('/popup'))
    from = seen.length
    await clickWithInput(app, '/popup', '#pop')
    expect(await waitFor(() => trackerSaw(from).length > 0, 20_000), `the popup reached the tracker (the pages open: ${JSON.stringify(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL())))}; the requests: ${requestsSeen()})`).toBe(true)
    expect(await waitFor(async () => await app.evaluate(({ webContents }, target) => webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(target) && !wc.isLoading()).length >= 1, landed), 20_000)).toBe(true)
    await bounced('a popup through the tracker', from)

    await delay(2500)
    expect(await cookiesIn(app, null, 'uid'), 'nothing the tracker gave the tunnel reached normal browsing').toEqual([expect.objectContaining({ value: normalIdentity })])

    // A page that navigates its tab to another site: that page loads signed out once (a page chose it, not the person); once it has loaded the site is added and follows normal browsing.
    from = seen.length
    await visitUntil(app, chrome, urlOf('/leave'), `https://${TRACKER}:${String(ports.decoy)}/landing`)
    expect(trackerSaw(from)[0], 'the first load of a site a page navigated to is signed out').not.toContain(normalIdentity)
    expect(await waitFor(async () => (await cookiesIn(app, PROXY_PROFILE, 'uid'))[0]?.['value'] === normalIdentity, 20_000), 'and then the site follows normal browsing').toBe(true)
    expect(recordOf(profile)).toEqual({ version: 1, domains: { 'proxy-profile': ['cdn-tracker.test', 'socks.test'] }, owed: false })
  } finally {
    await closeElectron(app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)

it('[tunnel profiles share sign-ins] a profile first made while the switch is off already holds the sign-in when its first page asks for it', async () => {
  const { app, chrome } = await start({ 'network.tunnel.separateSignIns': false })
  try {
    await visitWithoutPage(app, chrome, urlOf('/login'))
    expect(await cookiesIn(app, null, 'sid')).toHaveLength(1)
    await tabWith(app, chrome, 'socks5')
    const before = hits('tunnel')
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(hits('tunnel'), 'the site was reached through the tunnel').toBeGreaterThan(before)
    expect(lastCookie('/whoami', 'tunnel'), `the very first page of the new profile sends the sign-in (the site saw: ${requestsSeen()})`).toContain('sid=signed-in')
    expect(await cookiesIn(app, PROXY_PROFILE, 'sid')).toHaveLength(1)
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)

it('[tunnel profiles share sign-ins] a switch turned on and not yet cleared when the app stopped is cleared at the next start, whatever else starts', async () => {
  const first = await start({ 'network.tunnel.separateSignIns': false })
  let profile = ''
  try {
    profile = profileOf(first.app)
    await visitWithoutPage(first.app, first.chrome, urlOf('/login'))
    await tabWith(first.app, first.chrome, 'socks5')
    await visitWithoutPage(first.app, first.chrome, urlOf('/whoami'))
    expect(await cookiesIn(first.app, PROXY_PROFILE, 'sid'), 'the profile was given the sign-in').toHaveLength(1)
    await flushCookies(first.app)
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }
  // The person turned the switch on and the app stopped before the clear was done: the setting is saved, the record says a clear is owed.
  writeFileSync(join(profile, 'settings.json'), settingsFor({ 'network.tunnel.separateSignIns': true }))
  const owed = recordOf(profile) as { domains: unknown }
  writeFileSync(join(profile, RECORD), JSON.stringify({ version: 1, domains: owed.domains, owed: true }))
  const second = await start({}, profile)
  try {
    expect(await waitFor(async () => (await cookiesIn(second.app, PROXY_PROFILE, 'sid')).length === 0, 20_000), 'the profile\'s copy of the site was cleared at launch').toBe(true)
    expect(await cookiesIn(second.app, null, 'sid'), 'normal browsing kept its sign-in').toHaveLength(1)
    expect(await waitFor(() => JSON.stringify(recordOf(profile)) === JSON.stringify({ version: 1, domains: {}, owed: false }), 10_000), 'and nothing is owed any more').toBe(true)
  } finally {
    await closeElectron(second.app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)

it('[tunnel profiles share sign-ins] a start with the switch off makes the profile equal to normal browsing for the sites it keeps, and does not copy what only the profile holds into normal browsing', async () => {
  const first = await start()
  let profile = ''
  try {
    profile = profileOf(first.app)
    await visitWithoutPage(first.app, first.chrome, urlOf('/login'))
    await tabWith(first.app, first.chrome, 'socks5')
    await visitWithoutPage(first.app, first.chrome, urlOf('/other-login'))
    expect(await cookiesIn(first.app, PROXY_PROFILE, 'other'), 'the profile holds a cookie of its own').toHaveLength(1)
    await flushCookies(first.app)
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }
  // The site was already mirrored when the app stopped, and the profile gained a cookie the default session never heard of.
  writeFileSync(join(profile, 'settings.json'), settingsFor({ 'network.tunnel.separateSignIns': false }))
  writeFileSync(join(profile, RECORD), JSON.stringify({ version: 1, domains: { 'proxy-profile': ['socks.test'] }, owed: false }))
  const second = await start({}, profile)
  try {
    await tabWith(second.app, second.chrome, 'socks5')
    await visitWithoutPage(second.app, second.chrome, urlOf('/whoami'))
    expect(await waitFor(async () => (await cookiesIn(second.app, PROXY_PROFILE, 'sid')).length === 1 && (await cookiesIn(second.app, PROXY_PROFILE, 'other')).length === 0, 20_000), `the profile now holds normal browsing's cookies of the site and no others (it holds: ${JSON.stringify(await cookiesIn(second.app, PROXY_PROFILE))})`).toBe(true)
    await delay(2500)
    expect(await cookiesIn(second.app, null, 'other'), 'the profile-only cookie did not reach normal browsing').toEqual([])
    expect(lastCookie('/whoami', 'tunnel')).toContain('sid=signed-in')
    expect(lastCookie('/whoami', 'tunnel')).not.toContain('other=')
  } finally {
    await closeElectron(second.app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)
