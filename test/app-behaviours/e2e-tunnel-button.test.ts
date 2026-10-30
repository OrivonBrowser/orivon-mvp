// The tunnel button at the right end of the address pill: grey on a page that goes direct, purple once the person
// switches the tunnel on for the tab in the popover it opens and confirms the storage notice. The popover lists Nym
// with its logo and a switch, and leads to Settings > Tunnels at the browser-wide switch. The Nym module is the
// stand-in `e2e-app-routed-nym` uses.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-button.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAME = 'plain.nym.test'

interface Hosted { port: number, hits: () => number, close: () => Promise<void> }

async function host (title: string): Promise<Hosted> {
  let hits = 0
  const server: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

let dir: string
let app: ElectronApplication
let chrome: Page
let decoy: Hosted
let real: Hosted
const cleanups: Array<() => Promise<void> | void> = []
const url = (): string => `http://${NAME}:${String(decoy.port)}/`
const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-button-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  decoy = await host('direct')
  real = await host('tunnelled')
  cleanups.push(async () => { await decoy.close(); await real.close() })
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ failStart: false, log: logFile, targets: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } } }))
  const launched = await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`]
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The colour a token paints, as the engine computes it. */
const tokenColour = async (token: string): Promise<string> => await chrome.evaluate((name) => {
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  document.body.append(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  return colour
}, token)
const buttonColour = async (): Promise<string> => await chrome.evaluate(() => getComputedStyle(document.querySelector('#tunnel-btn') as Element).color)

async function openPopover (): Promise<Page> {
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-nym')
  return popover
}

it('is plain on the new tab and grey on a page that goes direct, and the key says nothing about the tunnel', async () => {
  expect(await chrome.locator('#tunnel-btn').isVisible(), 'the button is on the new tab, about the tab').toBe(true)
  expect(await chrome.getAttribute('#tunnel-btn', 'data-tunnel'), 'and plain while the tab\'s sites will go direct').toBeNull()
  await clickAddressBarRetrying(chrome, url())
  expect((await waitForTab(chrome, { address: url(), title: 'direct' })).ok).toBe(true)
  expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible())).toBe(true)
  expect(await chrome.getAttribute('#tunnel-btn', 'data-tunnel')).toBeNull()
  expect(await chrome.getAttribute('#tunnel-btn', 'aria-label')).toBe('Tunnels')
  expect(await buttonColour(), 'the plain pill colour').not.toBe(await tokenColour('--wtunnel'))
  expect(await chrome.getAttribute('#site-permissions-btn', 'data-tunnel'), 'the key does not carry the tunnel').toBeNull()
  await shoot(app, chrome, chrome, 'tunnel-button-direct')
}, 3 * QA_TEST_TIMEOUT_MS)

it('opens a list with Nym and the person\'s proxy, the logo of Nym, both switches off, the two panels and the link to Tunnels settings', async () => {
  const popover = await openPopover()
  expect(await popover.locator('.site-origin').textContent()).toBe('Tunnels')
  expect(await popover.locator('[role="tab"]').allTextContents(), 'two panels: the tab\'s own and the whole browser').toEqual(['This tab', 'Browser-wide'])
  expect(await popover.locator('#tunnel-tab-first').getAttribute('aria-selected'), 'a tab with no tunnel of its own, with the browser on none, opens on its own panel').toBe('true')
  expect(await popover.locator('.tunnel-row[data-tunnel]').count(), 'a row for each tunnel').toBe(2)
  expect(await popover.locator('.tunnel-row').count(), 'and the row of "Always use for this site", which a website\'s list has under them').toBe(await popover.locator('#tunnel-switch-always').count() + 2)
  expect(await popover.locator('.tunnel-row[data-tunnel="nym"] .tunnel-label').textContent()).toBe('Nym')
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-label').textContent()).toBe('Your proxy')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('false')
  const logoWidth = await popover.locator('img.tunnel-logo').evaluate((img) => (img as HTMLImageElement).complete ? (img as HTMLImageElement).naturalWidth : 0)
  expect(logoWidth, 'the logo is loaded').toBeGreaterThan(0)
  expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('false')
  expect(await popover.locator('#tunnel-settings-open').textContent()).toBe('Open Tunnels settings')
  expect(await popover.locator('#tunnel-notice-confirm').count()).toBe(0)
  expect(await popover.locator('#tunnel-switch-always').getAttribute('aria-checked'), '"Always use for this site" is off').toBe('false')
  expect(await popover.locator('#tunnel-switch-always').isDisabled(), 'and held while nothing is chosen to keep').toBe(true)
  await shoot(app, chrome, popover, 'tunnel-button-popover')
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(300)
}, 3 * QA_TEST_TIMEOUT_MS)

it('turns purple once the switch is on and the notice is confirmed, and the page comes through Nym', async () => {
  const popover = await openPopover()
  await popover.click('#tunnel-switch-nym')
  await popover.waitForSelector('.tunnel-notice')
  await popover.click('#tunnel-notice-confirm')
  expect(await waitFor(async () => (await activeTabInfo(chrome)).title === 'tunnelled', 60_000), 'the page came through Nym').toBe(true)
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on')).toBe(true)
  expect(await buttonColour()).toBe(await tokenColour('--wtunnel'))
  expect(await chrome.getAttribute('#tunnel-btn', 'aria-label'), 'the button says the choice is the tab\'s').toBe('Tunnels. This page goes through Nym. Set for this tab')
  // The popover closes when the tab moves to its session: opened again it shows the switch on.
  if (findPopup() !== undefined) await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(300)
  await shoot(app, chrome, chrome, 'tunnel-button-on')
  const again = await openPopover()
  expect(await again.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('true')
  expect(await again.locator('.tunnel-row[data-tunnel="nym"] .tunnel-state').textContent()).toContain('This tab\'s traffic goes through Nym')
  expect(await again.locator('#tunnel-switch-always').getAttribute('aria-checked'), 'the row set the tab, not the website').toBe('false')
  expect(await again.locator('#tunnel-switch-always').isDisabled(), 'and there is a choice to keep now').toBe(false)
  await shoot(app, chrome, again, 'tunnel-button-popover-on')
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(300)
}, 4 * QA_TEST_TIMEOUT_MS)

it('leads to Settings > Tunnels at the browser-wide switch from the Browser-wide panel, and closes the popover', async () => {
  const popover = await openPopover()
  await popover.click('#tunnel-tab-browser')
  await popover.click('#tunnel-settings-open')
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings/tunnels')))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings/tunnels')) as Page
  await settings.waitForSelector('#row-route-everywhere')
  expect(await settings.locator('.nav-item.current').textContent()).toBe('Tunnels')
  expect(await waitFor(async () => (await settings.locator('#row-route-everywhere').getAttribute('class'))?.includes('flash') === true || await settings.evaluate(() => document.activeElement?.closest('#row-route-everywhere') !== null)), 'the row is marked and has the keyboard').toBe(true)
  expect(await waitFor(() => findPopup() === undefined), 'the popover closed').toBe(true)
  await shoot(app, chrome, settings, 'tunnel-button-settings')
}, 3 * QA_TEST_TIMEOUT_MS)
