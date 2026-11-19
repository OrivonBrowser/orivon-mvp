// The tunnel button's list on a website sets the TAB; "Always use for this site" is what makes the tunnel the website's own. A
// `.eth` name stands for the website because its origin is written to disk, which a plain http fixture's never is: the file is
// where the difference between the two shows. A row writes nothing and the tunnel leaves with the tab; Always writes the entry,
// which outlives the tab and opens a new tab on the site with the switch on; turning Always off takes the entry away without
// loading the page again; a popup that names another website than the tab's is refused. The gateway the verifier host reads
// has a decoy on the same port, so a read that skipped the SOCKS5 fixture would be counted.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-website-tunnel-always.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { clickAddressBarRetrying, navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { alwaysIsOn, closeTunnelList, openTunnelList, pickTunnelForWebsite, pressAlways, pressRow } from '../support/tunnel-popup.js'

const GATEWAY = 'gw.always.test'
const ORIGIN = 'https://tunnelled.eth'
const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>eth fixture</title><body>eth fixture</body>' }

let dir: string
let profile = ''
let socks: Socks5Fixture
let real: Awaited<ReturnType<typeof startFixtureGateway>>
let decoy: Awaited<ReturnType<typeof startFixtureGateway>>
let app: ElectronApplication
let chrome: Page

const blocksAsked = (gateway: typeof real): number => gateway.requests.filter((request) => request.endsWith('?format=raw')).length

/** What routes.json says of the website: its entry, and whether it records storage kept apart for it. Undefined while the file does not exist. */
function saved (): { entry: 'nym' | 'socks5' | 'off' | undefined, apart: boolean } | undefined {
  const path = join(profile, 'routes.json')
  if (!existsSync(path)) return undefined
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const listed = (key: string): boolean => Array.isArray(file[key]) && (file[key] as unknown[]).includes(ORIGIN)
  const via = (file['via'] ?? {}) as Record<string, string>
  const entry = via[ORIGIN] === 'socks5' ? 'socks5' : listed('origins') ? 'nym' : listed('off') ? 'off' : undefined
  return { entry, apart: listed('apart') || listed('apartProxy') || listed('apartDirect') }
}

/** The session the website's page lives in, once it has loaded: the shared one or a profile's. */
const sessionOfSite = async (): Promise<'shared' | 'profile' | null> => await app.evaluate(({ webContents, session }, url) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === url && !wc.isLoading())
  return contents === undefined ? null : contents.session === session.defaultSession ? 'shared' : 'profile'
}, `${ORIGIN}/`)

/** Opens the website in the tab in front and waits for it, with the session it ended in. */
async function openSite (): Promise<void> {
  await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
  expect((await waitForTab(chrome, { title: 'eth fixture' }, 60_000)).ok, 'the website loaded').toBe(true)
  expect(await waitFor(async () => await sessionOfSite() !== null, 30_000)).toBe(true)
}

/** Closes every tab but a new one, so the next test starts on a tab with nothing chosen and the website unopened. */
async function freshTab (): Promise<void> {
  const before = await tabIds(chrome)
  await closeTunnelList(app, chrome)
  await chrome.click('#new-tab')
  expect(await waitFor(async () => (await tabIds(chrome)).length === before.length + 1)).toBe(true)
  for (const id of before) await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, id)
  expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
}

/** A command sent from the popup's own page, as a stale popup would send it. */
async function fromPopup (list: Page, command: 'always' | 'row', shown: string): Promise<{ ok: boolean } | null> {
  return await list.evaluate(async ([kind, origin]) => {
    const bridge = (window as unknown as { orivonSiteInfo: { setSiteAlways: (on: boolean, shown: string) => Promise<{ ok: boolean } | null>, setTunnel: (kind: null, shown: string) => Promise<{ ok: boolean } | null> } }).orivonSiteInfo
    return kind === 'always' ? await bridge.setSiteAlways(true, origin as string) : await bridge.setTunnel(null, origin as string)
  }, [command, shown] as const)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-website-tunnel-always-e2e-'))
  decoy = await startFixtureGateway({ tunnelled: SITE })
  real = await startFixtureGateway({ tunnelled: SITE })
  const decoyPort = new URL(decoy.url).port
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: { [`${GATEWAY}:${decoyPort}`]: { host: '127.0.0.1', port: Number(new URL(real.url).port) } }
  })
  const launched = await launchShell({
    env: {
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'tunnelled.eth': `ipfs://${real.roots['tunnelled']}` }),
      ORIVON_TEST_IPFS_GATEWAYS: `http://${GATEWAY}:${decoyPort}`
    },
    args: [`--host-resolver-rules=MAP ${GATEWAY} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir: string) => {
      profile = userDataDir
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
  app = launched.app
  chrome = launched.chrome
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await decoy.close()
  await real.close()
  await socks.close()
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:website-tunnel-always-a-row-sets-the-tab-only] a row on a website moves the tab into the tunnel and writes no entry for the website, "Always use for this site" stays off, and a tab opened after that tab closes is direct again', async () => {
  await navigateToFixture(app, `${ORIGIN}/`, 'eth fixture')
  expect(await waitFor(async () => await sessionOfSite() === 'shared', 30_000), 'the website starts in the shared session').toBe(true)
  const before = await openTunnelList(app, chrome, 'socks5')
  expect(await before.locator('#tunnel-tab-first').textContent(), 'the list is the tab\'s').toBe('This tab')
  expect(await before.locator('#tunnel-switch-always').getAttribute('aria-checked')).toBe('false')
  expect(await before.locator('#tunnel-switch-always').isDisabled(), 'nothing is chosen to keep yet').toBe(true)

  await before.click('#tunnel-switch-socks5')
  await before.waitForSelector('.tunnel-notice')
  await before.click('#tunnel-notice-confirm')
  expect(await waitFor(async () => await sessionOfSite() === 'profile', 30_000), 'the tab moved into the tunnel profile').toBe(true)
  expect(await waitFor(() => blocksAsked(real) > 0, 30_000), 'and the gateway was asked through the tunnel').toBe(true)

  const after = await openTunnelList(app, chrome, 'socks5')
  expect(await after.locator('#tunnel-switch-socks5').getAttribute('aria-checked'), 'the row is lit').toBe('true')
  expect(await alwaysIsOn(after), 'the website has no entry of its own').toBe(false)
  expect(await after.locator('#tunnel-switch-always').isDisabled(), 'and there is a choice to keep now').toBe(false)
  await delay(ABSENCE_SETTLE_MS)
  expect(saved()?.entry, 'routes.json names no tunnel for the website').toBeUndefined()
  expect(await waitFor(() => saved()?.apart === true), 'the visit is recorded as storage kept apart, as for any tab choice').toBe(true)

  // The tab closes with its choice: the same website in a new tab goes to the gateway directly.
  const tunnelled = blocksAsked(real)
  await freshTab()
  await openSite()
  expect(await sessionOfSite(), 'the website is in the shared session again, which this browser sends direct').toBe('shared')
  expect(blocksAsked(real), 'and the tunnel\'s gateway was not asked for it again').toBe(tunnelled)
  expect(saved()?.entry).toBeUndefined()
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:website-tunnel-always-keeps-the-tunnel-for-the-site] "Always use for this site" writes the website\'s entry without moving or loading the page again, and the entry outlives the tab', async () => {
  // The first test left the website's storage recorded, so the move is not asked about again.
  await pressRow(app, chrome, 'socks5')
  expect(await waitFor(async () => await sessionOfSite() === 'profile', 30_000)).toBe(true)
  expect(saved()?.entry, 'the row alone wrote no entry').toBeUndefined()

  const view = await waitFor(() => findViewShowing(app, chrome, `${ORIGIN}/`) !== undefined) ? findViewShowing(app, chrome, `${ORIGIN}/`) as Page : undefined
  await view?.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true })
  const asked = blocksAsked(real)
  await pressAlways(app, chrome, 'socks5')
  expect(await waitFor(() => saved()?.entry === 'socks5'), 'the website has its entry on disk').toBe(true)
  expect(saved()?.apart, 'and keeps recording the storage it has in the profile').toBe(true)
  await delay(ABSENCE_SETTLE_MS)
  expect(await view?.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), 'the page was not loaded again').toBe(true)
  expect(blocksAsked(real), 'and the gateway was not asked again').toBe(asked)
  expect(await sessionOfSite(), 'nor moved').toBe('profile')

  // The tab closes; the entry stays and carries the next tab.
  const direct = blocksAsked(decoy)
  await freshTab()
  await openSite()
  expect(await sessionOfSite(), 'a tab with no choice follows the entry into the tunnel profile').toBe('profile')
  expect(blocksAsked(decoy), 'without reading the gateway directly').toBe(direct)
  expect(saved()?.entry).toBe('socks5')
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:website-tunnel-always-opens-on-for-a-site-with-an-entry] a website that has an entry opens with "Always use for this site" on and its tunnel lit, in a tab that has no choice of its own, and the button does not say the choice is the tab\'s', async () => {
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on'), 'the button is lit for the page').toBe(true)
  const labelled = async (): Promise<string> => await chrome.getAttribute('#tunnel-btn', 'aria-label') ?? ''
  expect(await waitFor(async () => (await labelled()).startsWith('Tunnels. This page goes through your proxy')), 'the button says the page goes through the proxy').toBe(true)
  expect(await labelled(), 'without calling the tunnel the tab\'s').not.toContain('Set for this tab')
  const list = await openTunnelList(app, chrome, 'socks5')
  expect(await list.locator('#tunnel-tab-first').getAttribute('aria-selected'), 'the list opens on the tab\'s panel').toBe('true')
  expect(await list.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('true')
  expect(await alwaysIsOn(list)).toBe(true)
  expect(await list.locator('#tunnel-always-line').textContent()).toBe('Saved for this site, in every tab.')
  await closeTunnelList(app, chrome)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:website-tunnel-always-refuses-a-stale-popup] a command that names another website than the one the tab shows is refused, and neither the entry nor the tab changes', async () => {
  const list = await openTunnelList(app, chrome, 'socks5')
  expect(await fromPopup(list, 'row', 'https://elsewhere.example'), 'a row move on a website that has an entry').toMatchObject({ ok: false })
  expect(await fromPopup(list, 'always', 'https://elsewhere.example')).toMatchObject({ ok: false })
  await delay(ABSENCE_SETTLE_MS)
  expect(saved()?.entry, 'the entry is as it was').toBe('socks5')
  expect(await sessionOfSite(), 'and the page did not move').toBe('profile')
  expect(await list.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('true')
  await closeTunnelList(app, chrome)
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:website-tunnel-always-off-removes-the-entry-without-a-reload] turning "Always use for this site" off takes the entry away and the tab keeps the tunnel it went through, with no new load', async () => {
  const view = await waitFor(() => findViewShowing(app, chrome, `${ORIGIN}/`) !== undefined) ? findViewShowing(app, chrome, `${ORIGIN}/`) as Page : undefined
  await view?.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true })
  const asked = blocksAsked(real)
  const list = await openTunnelList(app, chrome, 'socks5')
  await list.click('#tunnel-switch-always')
  await list.waitForSelector('#tunnel-switch-always[aria-checked="false"]')
  expect(await waitFor(() => saved()?.entry === undefined), 'the entry is gone from disk').toBe(true)
  await delay(ABSENCE_SETTLE_MS)
  expect(await view?.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), 'the page was not loaded again').toBe(true)
  expect(blocksAsked(real)).toBe(asked)
  expect(await sessionOfSite(), 'it is still in the tunnel profile').toBe('profile')
  expect(await list.locator('#tunnel-switch-socks5').getAttribute('aria-checked'), 'the tunnel is still lit, now as the tab\'s choice').toBe('true')
  expect(await waitFor(async () => (await chrome.getAttribute('#tunnel-btn', 'aria-label'))?.includes('Set for this tab') === true), 'the button now says the choice is the tab\'s').toBe(true)
  await closeTunnelList(app, chrome)

  // Nothing of it is left for another tab.
  await freshTab()
  await openSite()
  expect(await sessionOfSite(), 'a new tab has the website in the shared session again').toBe('shared')
  expect(blocksAsked(real), 'and does not send it through the tunnel').toBe(asked)
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:website-tunnel-always-keeps-the-tunnel-for-the-site] with Always on, turning the lit row off takes the entry and the tab\'s choice away together, so the page really leaves the tunnel', async () => {
  await freshTab()
  await openSite()
  expect(await sessionOfSite(), 'the website starts direct').toBe('shared')
  await pickTunnelForWebsite(app, chrome, 'socks5', { inProfile: async () => await sessionOfSite() === 'profile' })
  expect(saved()?.entry, 'the website has its entry').toBe('socks5')

  const list = await openTunnelList(app, chrome, 'socks5')
  expect(await alwaysIsOn(list)).toBe(true)
  await list.click('#tunnel-switch-socks5')
  expect(await waitFor(() => saved()?.entry === undefined), 'the entry went with the row').toBe(true)
  expect(await waitFor(async () => await sessionOfSite() === 'shared', 30_000), 'and the page left the tunnel profile').toBe(true)
}, 6 * QA_TEST_TIMEOUT_MS)
