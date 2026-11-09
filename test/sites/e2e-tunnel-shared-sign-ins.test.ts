// "Keep tunneled sites separate" (Settings, Tunnels) is on by default: a site in a tunnel profile has cookies of its own. Turned off,
// the cookies of the tunnel profiles and of normal browsing are kept the same both ways, so a tab that carries a tunnel choice is
// signed in to the accounts normal browsing is signed in to, with the route of the tab unchanged (the site is reached through the
// SOCKS5 fixture, never directly). Turned on again, the profiles' cookies are cleared and normal browsing keeps its own. The switch
// is the real one in Settings; cookies are read from each session in the main process.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/sites/e2e-tunnel-shared-sign-ins.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visitWithoutPage } from '../support/qa-helpers.js'
import { activeTabInfo, delay, waitFor } from '../support/smoke-helpers.mjs'

const SITE = 'bank.socks.test'
const PROXY_PROFILE = 'persist:proxy-profile'
const DIRECT_PROFILE = 'persist:direct-profile'
const SWITCH = '#row-route-separate-sign-ins input[type=checkbox]'
type Choice = 'socks5' | 'direct'

/** `via` is the route a request took: the SOCKS5 fixture's (`tunnel`) or straight to the host the resolver maps (`direct`). */
interface Seen { path: string, cookie: string, via: 'tunnel' | 'direct' }

let socks: Socks5Fixture
let dir: string
let spki = ''
const ports = { real: 0, decoy: 0 }
const servers: Server[] = []
const seen: Seen[] = []
let visits = 0

/** The page a request for `path` gets: the cookies a site sets on sign-in, sign-out and in a tunnelled tab. */
function answer (via: Seen['via'], request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  seen.push({ path, cookie: request.headers.cookie ?? '', via })
  const headers: Record<string, string | string[]> = { 'content-type': 'text/html', 'cache-control': 'no-store' }
  if (path === '/login') headers['set-cookie'] = 'sid=signed-in; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600'
  if (path === '/tunnel-login') headers['set-cookie'] = 'tunnelled=yes; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'
  if (path === '/other-login') headers['set-cookie'] = 'other=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'
  if (path === '/logout') headers['set-cookie'] = 'sid=; Path=/; Secure; Max-Age=0'
  response.writeHead(200, headers).end(`<!doctype html><title>${path}</title><body>${path}</body>`)
}

/** An https site: a plain-http one lives in a profile kept in memory, which the mirror never touches. The page address names the decoy's port, so a request that skipped the tunnel lands on the decoy and is told apart. */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-shared-sign-ins-e2e-'))
  const tls = selfSigned(dir, [SITE])
  spki = tls.spki
  const make = async (via: Seen['via']): Promise<number> => {
    const hosted = createServer(tls, (request, response) => { answer(via, request, response) })
    await new Promise<void>((resolve) => { hosted.listen(0, '127.0.0.1', resolve) })
    servers.push(hosted)
    return (hosted.address() as AddressInfo).port
  }
  ports.real = await make('tunnel')
  ports.decoy = await make('direct')
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${SITE}:${String(ports.decoy)}`]: { host: '127.0.0.1', port: ports.real } } })
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

async function start (settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    args: [`--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, ...settings } }))
    }
  })
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

it('[tunnel profiles share sign-ins] separate by default; with the switch off the tunnelled tab is signed in to what normal browsing is, both ways, attributes kept; on again, the profiles are cleared', async () => {
  const { app, chrome } = await start()
  try {
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

    // Off: the profile receives the sign-in with its attributes, and the tunnelled tab sends it, still through the tunnel.
    await setSeparate(app, chrome, false)
    expect(await waitFor(async () => (await cookiesIn(app, PROXY_PROFILE, 'sid')).length === 1, 20_000), 'the sign-in reached the profile').toBe(true)
    const copied = (await cookiesIn(app, PROXY_PROFILE, 'sid'))[0] as Record<string, unknown>
    expect(copied).toMatchObject({ value: 'signed-in', domain: SITE, hostOnly: true, httpOnly: true, secure: true, sameSite: 'lax', session: false, path: '/' })
    expect(copied['expirationDate'] as number, 'the expiry is the cookie\'s own').toBeGreaterThan(Date.now() / 1000)
    const direct = hits('direct')
    const through = hits('tunnel')
    await visitWithoutPage(app, chrome, urlOf('/whoami'))
    expect(hits('tunnel'), 'the site was reached through the tunnel again').toBeGreaterThan(through)
    expect(hits('direct'), 'and not directly').toBe(direct)
    expect(lastCookie('/whoami', 'tunnel'), `the tunnelled tab is signed in to the same account (the site saw: ${requestsSeen()}; the profile holds: ${JSON.stringify(await cookiesIn(app, PROXY_PROFILE))})`).toContain('sid=signed-in')
    expect(await app.evaluate(({ webContents, session }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes('/whoami') && wc.session !== session.defaultSession)), 'the tab still lives in a session of its own').toBe(true)

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
    expect(lastCookie('/whoami', 'direct'), 'a profile made after the switch was moved starts with the cookies').toContain('sid=signed-in')
    expect(await cookiesIn(app, DIRECT_PROFILE, 'sid')).toHaveLength(1)

    // Sessions that are not profiles are left alone.
    expect(await cookiesIn(app, 'persist:app-0123456789abcdef'), 'an app\'s session is not mirrored').toEqual([])
    expect(await cookiesIn(app, 'tunnel-profile-memory'), 'a profile kept in memory is not mirrored').toEqual([])

    // On again: the profiles' cookies go, normal browsing keeps its own, and the tunnelled tab is signed out.
    await setSeparate(app, chrome, true)
    expect(await waitFor(async () => (await cookiesIn(app, PROXY_PROFILE)).length === 0 && (await cookiesIn(app, DIRECT_PROFILE)).length === 0, 20_000), 'the profiles\' cookies were cleared').toBe(true)
    expect((await cookiesIn(app, null)).map((cookie) => cookie['name']).sort(), 'normal browsing kept its cookies').toEqual(['sid', 'tunnelled'])
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
