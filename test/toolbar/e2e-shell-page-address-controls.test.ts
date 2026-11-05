// The Web3 / Web2 switch and the tunnel button on the shell's own pages (orivon://), driven with the real shell. A shell page has no
// site mark for the switch to be mistaken for, so the switch shows there all the time; its tunnel button is about the browser-wide
// setting alone, because such a page never goes through a tunnel, and its popup is the Browser-wide panel with no panel of the tab and
// no "Always use for this site". Main refuses what a popup of such a page still sends: a tab's tunnel and a website's own entry.
// The Nym module is the stand-in `e2e-browser-wide-tunnel` uses.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/toolbar/e2e-shell-page-address-controls.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { EMPTY_WASM, FAKE_NYM_MODULE } from '../app-behaviours/nym-stand-in.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, waitFor } from '../support/smoke-helpers.mjs'

type Shell = { orivonShell: { openInternal: (page: string, path?: string) => void } }
type TabChoiceSeam = { __orivonDevTabTunnel?: { choiceOf: (tabId: string) => string | undefined } }
type PopupBridge = { orivonSiteInfo: { setTunnel: (kind: 'nym' | 'socks5' | null, shown?: string) => Promise<{ ok: boolean } | null>, setSiteAlways: (on: boolean, shown: string) => Promise<{ ok: boolean } | null> } }

const SHELL_PAGE_LABEL = 'Tunnels. Sites go through Nym by default'
const DIRECT_LABEL = 'Tunnels. Sites go direct by default'

let dir: string
let moduleDir: string
let configFile: string
let server: FixtureServer
const cleanups: Array<() => Promise<void> | void> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-shell-page-controls-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  configFile = join(dir, 'fake.json')
  writeFileSync(join(dir, 'fake.log'), '')
  writeFileSync(configFile, JSON.stringify({ failStart: false, log: join(dir, 'fake.log'), targets: {} }))
  server = await startServer((_request, response) => { html(response, '<!doctype html><title>a website</title><body>a website</body>') })
  cleanups.push(async () => { await server.close() })
}, 60_000)

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function start (settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: settings })) }
  })
}

const findPopup = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())
const shown = async (chrome: Page, selector: string): Promise<boolean> => await chrome.locator(selector).isVisible()
const checked = async (popup: Page, id: string): Promise<boolean> => (await popup.locator(`#${id}`).getAttribute('aria-checked')) === 'true'

async function openSettings (app: ElectronApplication, chrome: Page): Promise<void> {
  await chrome.evaluate(() => { (window as unknown as Shell).orivonShell.openInternal('settings', '/') })
  expect(await waitFor(async () => String((await activeTabInfo(chrome) as { address?: string }).address).startsWith('orivon://settings'))).toBe(true)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
}

it('shows the Web3 / Web2 switch and the tunnel button on orivon://settings, hides the switch beside a website again, and the button says what the browser-wide tunnel does', async () => {
  const { app, chrome } = await start({ 'network.tunnel.everywhere': true })
  try {
    // A website: the switch gives way to the site's own mark, and the button is about the tab.
    await visit(app, chrome, `${server.origin}/`)
    expect(await waitFor(async () => !(await shown(chrome, '#search-mode'))), 'no switch beside a website\'s address').toBe(true)
    expect(await shown(chrome, '#tunnel-btn')).toBe(true)

    await openSettings(app, chrome)
    expect(await waitFor(async () => await shown(chrome, '#search-mode')), 'the switch is there on a shell page with the field not in use').toBe(true)
    expect(await chrome.locator('#search-mode').innerText()).toBe('Web3')
    expect(await shown(chrome, '#web3-mark'), 'a shell page has no site mark').toBe(false)
    expect(await shown(chrome, '#site-permissions-btn'), 'nor a key').toBe(false)
    expect(await waitFor(async () => await shown(chrome, '#tunnel-btn')), 'the tunnel button is there').toBe(true)
    expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on'), 'lit while the whole browser is on Nym').toBe(true)
    expect(await chrome.getAttribute('#tunnel-btn', 'aria-label')).toBe(SHELL_PAGE_LABEL)
    await shoot(app, chrome, chrome, 'shell-page-address-controls')

    // The switch still works from a shell page.
    await chrome.locator('#search-mode').click()
    expect(await waitFor(async () => (await chrome.locator('#search-mode').innerText()) === 'Web2')).toBe(true)
    await chrome.locator('#search-mode').click()
    expect(await waitFor(async () => (await chrome.locator('#search-mode').innerText()) === 'Web3')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)

it('opens the Browser-wide panel alone from a shell page, sets the whole browser from it, and refuses a tab choice or a website\'s entry its page still sends', async () => {
  const { app, chrome } = await start({ 'network.tunnel.everywhere': true })
  try {
    await openSettings(app, chrome)
    expect(await waitFor(async () => await shown(chrome, '#tunnel-btn'))).toBe(true)
    await chrome.click('#tunnel-btn')
    expect(await waitFor(() => findPopup(app) !== undefined), 'the popup opened').toBe(true)
    const popup = findPopup(app) as Page
    await popup.waitForSelector('#tunnel-switch-nym')

    expect(await popup.locator('.site-origin').textContent()).toBe('Tunnels')
    expect(await popup.locator('[role="tab"]').count(), 'no choice between panels: there is only the browser\'s').toBe(0)
    expect(await popup.locator('#tunnel-switch-always').count(), 'no "Always use for this site"').toBe(0)
    expect(await popup.locator('.site-claim').count(), 'nothing about the page, which has no tunnel').toBe(0)
    expect(await popup.locator('.tunnel-row[data-tunnel]').count()).toBe(2)
    expect(await popup.locator('#tunnel-switch-nym').getAttribute('aria-label')).toBe('Use Nym for the whole browser')
    expect(await checked(popup, 'tunnel-switch-nym'), 'the browser is on Nym').toBe(true)
    expect(await popup.locator('#tunnel-switch-nodes').count(), 'the nodes switch is the browser\'s').toBe(1)
    expect(await popup.locator('#tunnel-settings-open').textContent()).toBe('Open Tunnels settings')
    await shoot(app, chrome, popup, 'shell-page-tunnel-popup')

    // What a stale or hostile popup page could still send is refused by main: nothing about the tab or a website changes.
    const tabId = String((await activeTabInfo(chrome) as { activeId?: string }).activeId)
    const sent = await popup.evaluate(async () => {
      const bridge = (window as unknown as PopupBridge).orivonSiteInfo
      return [await bridge.setTunnel('socks5'), await bridge.setTunnel(null, 'https://example.com'), await bridge.setSiteAlways(true, 'https://example.com'), await bridge.setSiteAlways(true, 'orivon://settings')]
    })
    expect(sent.map((answer) => answer?.ok), 'every one was refused').toEqual([false, false, false, false])
    expect(await app.evaluate((_electron, id) => (globalThis as unknown as TabChoiceSeam).__orivonDevTabTunnel?.choiceOf(id as string), tabId), 'the tab was given no tunnel').toBeUndefined()
    expect(await chrome.getAttribute('#tunnel-btn', 'aria-label'), 'and the button reads the same').toBe(SHELL_PAGE_LABEL)

    // The Browser-wide switch is what the popup is for: turning it off sends the whole browser direct, and the button follows.
    await popup.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null), 'the button is plain again').toBe(true)
    expect(await chrome.getAttribute('#tunnel-btn', 'aria-label')).toBe(DIRECT_LABEL)
    expect(await checked(popup, 'tunnel-switch-nym')).toBe(false)
    expect(await popup.locator('[role="tab"]').count(), 'still only the browser\'s panel').toBe(0)

    await chrome.click('#tunnel-btn')
    expect(await waitFor(() => findPopup(app) === undefined), 'pressing the button again closes the popup').toBe(true)
    await delay(ABSENCE_SETTLE_MS)
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)
