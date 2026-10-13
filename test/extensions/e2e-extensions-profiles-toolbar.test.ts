// The toolbar acts on the profile of the tab in front. With a website of the tunnel profile in front, the extension's button is
// drawn from the tunnel profile's instance of the library, a click opens the popup of the tunnel profile's copy of the extension
// (a view of that session), the popup's chrome.tabs.query answers with the tabs of that session, and the options page it opens
// is a page of that session too; with a website of the direct profile in front the same holds for the direct profile, and with a
// plain website in front the list is the default session's again.
// Fixture: test/apps/extensions/action-popup/ (an MV3 action with a popup that calls chrome.tabs and chrome.runtime).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-profiles-toolbar.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { shoot } from '../support/auth-support.js'
import { seedExtensions } from '../support/extensions-fixtures.js'
import { selfSigned } from '../support/self-signed.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { evaluateRetrying, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAMES = { tunnelled: 'tunnelled.socks.test', direct: 'direct.socks.test', plain: 'plain.socks.test' } as const
type Name = keyof typeof NAMES
const TUNNEL = 'persist:tunnel-profile'
const DIRECT = 'persist:direct-profile'
const DEFAULT_LIST = 'orivon-extensions-default'

let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let dir: string
let extensionId = ''
const servers: Server[] = []
const ports = {} as Record<Name, number>

async function serve (title: string, tls: { cert: string, key: string }): Promise<{ port: number, decoy: number }> {
  const make = async (): Promise<number> => {
    const server = createServer(tls, (_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push(server)
    return (server.address() as AddressInfo).port
  }
  return { port: await make(), decoy: await make() }
}

const url = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}/`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-extensions-profiles-toolbar-e2e-'))
  const tls = selfSigned(dir, Object.values(NAMES))
  const real: Partial<Record<Name, number>> = {}
  for (const name of Object.keys(NAMES) as Name[]) {
    const served = await serve(name, tls)
    ports[name] = served.decoy
    real[name] = served.port
  }
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: { [`${NAMES.tunnelled}:${String(ports.tunnelled)}`]: { host: '127.0.0.1', port: real.tunnelled as number } }
  })
  const origin = (name: Name): string => `https://${NAMES[name]}:${String(ports[name])}`
  const launched = await launchShell({
    sandbox: true,
    args: [`--host-resolver-rules=${Object.values(NAMES).map((name) => `MAP ${name} 127.0.0.1`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, `--ignore-certificate-errors-spki-list=${tls.spki}`],
    seedProfile: async (userDataDir: string) => {
      mkdirSync(join(userDataDir, 'extensions'), { recursive: true })
      extensionId = seedExtensions(userDataDir, ['action-popup', 'content-marker'])[0]?.id ?? ''
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'extensions.pinNew': true } }))
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [origin('tunnelled')], off: [origin('direct')], apart: [origin('tunnelled')], apartDirect: [origin('direct')] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await socks.close()
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function visit (name: Name): Promise<void> {
  await clickAddressBarRetrying(chrome, url(name))
  expect((await waitForTab(chrome, { address: url(name), title: name })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url(name)) !== undefined)).toBe(true)
}

const listPartition = async (): Promise<string | null> => await evaluateRetrying(chrome, () => document.querySelector('browser-action-list')?.getAttribute('partition') ?? null)

/** The extension's button is drawn, and it is the one of `partition`'s state: a button of the list's earlier partition is redrawn once that state arrives. */
const buttonDrawn = async (partition: string): Promise<boolean> => await chrome.evaluate(([id, wanted]) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`#${id}`)?.getAttribute('partition') === wanted, [extensionId, partition] as const)

const sitePopover = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

const popupPage = (): Page | undefined => app.windows().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/popup.html`))

/** The name of the session the popup's page, and each page of the extension, runs in. */
const sessionOfPages = async (): Promise<string[]> => await app.evaluate(({ webContents, session }, id) => {
  const names = new Map([[session.defaultSession, 'default'], [session.fromPartition('persist:tunnel-profile'), 'persist:tunnel-profile'], [session.fromPartition('persist:direct-profile'), 'persist:direct-profile']])
  return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().startsWith(`chrome-extension://${id}/`)).map((wc) => `${wc.getURL().slice(`chrome-extension://${id}/`.length)} in ${names.get(wc.session) ?? 'other'}`)
}, extensionId)

async function useToolbarOn (name: Name, partition: string, session: string): Promise<void> {
  await visit(name)
  expect(await waitFor(async () => await listPartition() === partition), `the toolbar speaks to ${partition}`).toBe(true)
  expect(await waitFor(async () => await buttonDrawn(partition), 20_000), 'the extension\'s button is drawn').toBe(true)
  await shoot(app, chrome, chrome, `profiles-toolbar-${name}`)
  await chrome.click('#site-permissions-btn')
  expect(await waitFor(() => sitePopover() !== undefined)).toBe(true)
  const popover = sitePopover() as Page
  await popover.waitForSelector('.tunnel-section')
  expect(await popover.locator('.tunnel-section').textContent(), 'the popover says what the profile gives the extensions').toContain('Each profile keeps its own settings for them')
  await shoot(app, chrome, popover, `profiles-popover-${name}`)
  await chrome.click('#site-permissions-btn')
  expect(await waitFor(() => sitePopover() === undefined)).toBe(true)
  await chrome.click(`browser-action-list >> css=#${extensionId}`)
  expect(await waitFor(() => popupPage() !== undefined, 20_000), 'a click opens the popup').toBe(true)
  const popup = popupPage() as Page
  expect(await waitFor(async () => await evaluateRetrying(popup, () => document.title) === 'Action Popup')).toBe(true)
  const pages = await sessionOfPages()
  expect(pages, `the popup is a page of the profile's copy: ${JSON.stringify(pages)}`).toContain(`popup.html in ${session}`)

  await popup.click('#query')
  expect(await waitFor(async () => (await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')) !== '')).toBe(true)
  const queried = JSON.parse(await evaluateRetrying(popup, () => document.getElementById('result')?.textContent ?? '')) as { tabs: Array<{ id: number, url: string }> }
  expect(queried.tabs.map((tab) => tab.url), 'chrome.tabs.query answers with the tab of the profile in front').toContain(url(name))

  await popup.click('#options')
  expect(await waitFor(async () => (await sessionOfPages()).includes(`options.html in ${session}`), 20_000), 'the options page it opens is a page of the same session').toBe(true)
  // A second click on the button closes the popup, still of the same session: the options page in front is a tab of it.
  await chrome.click(`browser-action-list >> css=#${extensionId}`)
  expect(await waitFor(() => popupPage() === undefined, 10_000)).toBe(true)
}

it('[app:extensions-run-in-the-profiles] the toolbar button, its popup, chrome.tabs and the options page act on the tunnel profile while one of its websites is in front', async () => {
  await useToolbarOn('tunnelled', TUNNEL, TUNNEL)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:extensions-run-in-the-profiles] and on the direct profile, and the default session\'s toolbar is back for a plain website', async () => {
  await useToolbarOn('direct', DIRECT, DIRECT)
  await visit('plain')
  expect(await waitFor(async () => await listPartition() === DEFAULT_LIST), 'the toolbar is the default session\'s again').toBe(true)
  expect(await waitFor(async () => await buttonDrawn(DEFAULT_LIST), 20_000)).toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)
