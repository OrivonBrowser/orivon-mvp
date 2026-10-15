// "Open a private window with Nym": the command starts a private session of its own whose browser-wide tunnel is on, is
// Nym and cannot be turned off, whatever the window that opened it has chosen. The held process is launched here the way
// the command launches it (`--orivon-private --orivon-private-tunnel=nym`, over a profile whose settings say otherwise),
// and the command itself is run from an ordinary window to see what it starts. The Nym module is the stand-in
// `e2e-app-routed-nym` uses.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/window/e2e-private-window-nym.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, afterEach, expect, it } from 'vitest'
import { EMPTY_WASM, FAKE_NYM_MODULE } from '../app-behaviours/nym-stand-in.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { bindingOf, clickAddressBarRetrying, shownBinding } from '../support/e2e-helpers.js'
import { shoot } from '../support/auth-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, evaluateRetrying, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { privatePeer, processesWith } from './private-peer.js'

const NAME = 'private.nym.test'
const FLAG = '--orivon-private-tunnel=nym'
/** What the profile that opens a window with Nym has chosen: everything contrary. */
const CONTRARY = { version: 2, values: { 'network.tunnel.everywhere': false, 'network.route.kind': 'socks5', 'network.route.proxy': '127.0.0.1:9', 'network.nym.enabled': false, 'appearance.theme': 'dark' } }

interface Hosted { port: number, hits: () => number, close: () => Promise<void> }

async function host (title: string): Promise<Hosted> {
  let hits = 0
  const server: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

const cleanups: Array<() => Promise<void> | void> = []
const peerPids: number[] = []
afterEach(async () => {
  for (const pid of peerPids.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

interface World { app: ElectronApplication, chrome: Page, decoy: Hosted, real: Hosted, url: string, log: () => string[], userData: string }

/** The held process, started as the command starts it, over a profile whose settings say the opposite. */
async function launchHeld (failStart: boolean, filesMissing = false): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-private-nym-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  const decoy = await host('direct')
  const real = await host('tunnelled')
  cleanups.push(async () => { await decoy.close(); await real.close() })
  const logFile = join(dir, 'fake.log')
  writeFileSync(logFile, '')
  const configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ failStart, log: logFile, targets: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } } }))
  const { app, chrome } = await launchShell({
    // With the module's files missing there is no stand-in: the build holds none, as a package whose Nym files were removed.
    env: filesMissing ? {} : { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: ['--orivon-private', FLAG, `--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(CONTRARY)) }
  })
  cleanups.push(async () => { await closeElectron(app) })
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
  return { app, chrome, decoy, real, userData, url: `http://${NAME}:${String(decoy.port)}/`, log: (): string[] => readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '') }
}

const pageAt = (app: ElectronApplication, prefix: string): Page | undefined => app.windows().find((w) => w.url().startsWith(prefix) && !w.isClosed())

async function openPage (app: ElectronApplication, chrome: Page, page: string, path = '/'): Promise<Page> {
  await chrome.evaluate(([name, at]) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal(name as string, at as string) }, [page, path] as const)
  expect(await waitFor(() => pageAt(app, `orivon://${page}`) !== undefined)).toBe(true)
  return pageAt(app, `orivon://${page}`) as Page
}

const ask = async (page: Page, domain: string, command: object): Promise<unknown> =>
  await page.evaluate(async ([d, c]) => await (window as unknown as { orivonInternal: { request: (domain: string, command: unknown) => Promise<unknown> } }).orivonInternal.request(d as string, c), [domain, command] as const)

it('the held window has the tunnel on before its first request, whatever the profile that opened it chose, and its first page arrives through Nym', async () => {
  const world = await launchHeld(false)
  // Before anything has loaded: the sessions are already stopped or pointed at the tunnel, never direct.
  expect(await world.app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/')), 'the default session is not direct from the start').not.toBe('DIRECT')
  expect(world.log().filter((line) => line.startsWith('tcp ') || line.startsWith('udp ')), 'nothing was dialled for a page nobody asked for').toEqual([])

  await clickAddressBarRetrying(world.chrome, world.url)
  expect((await waitForTab(world.chrome, { address: world.url, title: 'tunnelled' }, 60_000)).ok, 'the page came through Nym').toBe(true)
  expect(world.log().some((line) => line.startsWith('tcp ') && line.endsWith(`${NAME}:${String(world.decoy.port)}`)), world.log().join('|')).toBe(true)
  expect(world.decoy.hits(), 'the decoy on the same address was never reached').toBe(0)

  // The tunnel button is purple from the first page, and the chip says what the window is.
  expect(await waitFor(async () => await world.chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on')).toBe(true)
  const chip = await evaluateRetrying(world.chrome, () => { const el = document.querySelector<HTMLElement>('#profile-chip'); return { hidden: el?.hidden ?? true, text: el?.textContent ?? null, title: el?.title ?? null } })
  expect(chip).toMatchObject({ hidden: false, text: 'Private with Nym' })
  expect(chip.title).toContain('Nym')

  await shoot(world.app, world.chrome, world.chrome, 'private-window-nym-chrome')

  // The settings file this process read is the ordinary one with the three choices written over.
  const written = JSON.parse(readFileSync(join(world.userData, 'settings.json'), 'utf8')) as { version: number, values: Record<string, unknown> }
  expect(written.version).toBe(2)
  expect(written.values).toMatchObject({ 'network.tunnel.everywhere': true, 'network.route.kind': 'nym', 'network.nym.enabled': true, 'appearance.theme': 'dark' })
}, 4 * QA_TEST_TIMEOUT_MS)

it('says what it is on the Private page, shows the Tunnels switches on and fixed with a line that says why, and refuses a change from the page', async () => {
  const world = await launchHeld(false)
  const priv = await openPage(world.app, world.chrome, 'private')
  await priv.waitForSelector('h1')
  expect(await priv.locator('h1').textContent()).toBe('You are in a private window with Nym')
  expect(await priv.locator('.lead').textContent()).toContain('Every page and everything Orivon sends for itself goes through Nym')
  expect(await priv.locator('button.primary').textContent()).toBe('Open another private window with Nym')
  await shoot(world.app, world.chrome, priv, 'private-window-nym-page')

  const settings = await openPage(world.app, world.chrome, 'settings', '/tunnels')
  await settings.waitForSelector('#row-route-everywhere input[type=checkbox]')
  for (const row of ['route-everywhere', 'route-nym-enabled']) {
    const box = settings.locator(`#row-${row} input[type=checkbox]`)
    expect(await box.isChecked(), `${row} shows on`).toBe(true)
    expect(await box.isDisabled(), `${row} is fixed`).toBe(true)
  }
  expect(await settings.locator('#row-route-kind select').isDisabled(), 'the tunnel choice is fixed').toBe(true)
  expect(await settings.locator('#row-route-kind select').inputValue()).toBe('nym')
  for (const row of ['route-kind', 'route-everywhere', 'route-nym-enabled']) {
    expect(await settings.locator(`#row-${row}`).textContent(), row).toContain('This private window always goes through Nym')
    expect(await settings.locator(`#row-${row} .changed`).count(), `${row} offers no Reset`).toBe(0)
  }
  await shoot(world.app, world.chrome, settings, 'private-window-nym-settings')

  // The page asks for the opposite and is told no; nothing moves.
  expect(await ask(settings, 'settings', { type: 'set', key: 'network.tunnel.everywhere', value: false })).toEqual({ ok: false, reason: 'locked' })
  expect(await ask(settings, 'settings', { type: 'set', key: 'network.route.kind', value: 'socks5' })).toEqual({ ok: false, reason: 'locked' })
  expect(await ask(settings, 'settings', { type: 'set', key: 'network.nym.enabled', value: false })).toEqual({ ok: false, reason: 'locked' })
  expect(await ask(settings, 'settings', { type: 'reset', key: 'network.tunnel.everywhere' })).toEqual({ ok: false, reason: 'locked' })
  expect(await world.app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/'))).not.toBe('DIRECT')
}, 4 * QA_TEST_TIMEOUT_MS)

it('shows the site\'s tunnel switch on and fixed in the popover, and never makes a site-off entry', async () => {
  const world = await launchHeld(false)
  await clickAddressBarRetrying(world.chrome, world.url)
  expect((await waitForTab(world.chrome, { address: world.url, title: 'tunnelled' }, 60_000)).ok).toBe(true)
  expect(await waitFor(async () => await world.chrome.locator('#tunnel-btn').isVisible())).toBe(true)
  await world.chrome.click('#tunnel-btn')
  const findPopup = (): Page | undefined => world.app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch')
  expect(await popover.locator('#tunnel-switch').getAttribute('aria-checked')).toBe('true')
  expect(await popover.locator('#tunnel-switch').isDisabled(), 'the switch is fixed').toBe(true)
  expect(await popover.locator('.tunnel-section').textContent()).toContain('This private window always goes through Nym')
  await shoot(world.app, world.chrome, popover, 'private-window-nym-popover')
  // Even forced, the switch makes no entry: the page stays on the tunnel.
  await popover.locator('#tunnel-switch').evaluate((el) => { (el as HTMLButtonElement).disabled = false; (el as HTMLButtonElement).click() })
  await delay(1500)
  expect((await activeTabInfo(world.chrome)).title).toBe('tunnelled')
  expect(world.decoy.hits()).toBe(0)
}, 4 * QA_TEST_TIMEOUT_MS)

it('fails closed when Nym cannot start: the page does not load and nothing arrives anywhere', async () => {
  const world = await launchHeld(true)
  await clickAddressBarRetrying(world.chrome, world.url)
  await delay(5000)
  expect((await activeTabInfo(world.chrome)).title).not.toBe('tunnelled')
  expect((await activeTabInfo(world.chrome)).title).not.toBe('direct')
  expect(world.decoy.hits() + world.real.hits(), 'nothing arrived anywhere').toBe(0)
  expect(await world.app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/'))).not.toBe('DIRECT')
}, 4 * QA_TEST_TIMEOUT_MS)

it('fails closed when Nym\'s files are missing: a plain http page says the tunnel did not carry it, a secure page gets a sheet, and nothing arrives anywhere', async () => {
  const world = await launchHeld(false, true)
  await clickAddressBarRetrying(world.chrome, world.url)
  const plain = (): Page | undefined => world.app.windows().find((w) => w.url() === world.url && !w.isClosed())
  expect(await waitFor(async () => (await plain()?.locator('h1').textContent({ timeout: 1000 }).catch(() => '')) === 'The tunnel did not carry this page', 60_000), 'the page itself says why').toBe(true)
  await clickAddressBarRetrying(world.chrome, `https://${NAME}/`)
  const sheetPage = (): Page | undefined => world.app.windows().filter((w) => w.url().includes('overlay=load-error') && !w.isClosed()).at(-1)
  expect(await waitFor(() => sheetPage() !== undefined, 60_000), 'a sheet explains the failure').toBe(true)
  const sheet = sheetPage() as Page
  await sheet.waitForSelector('.load-error-text')
  expect(await sheet.locator('.load-error-text').textContent()).toContain('The tunnel did not carry this page')
  expect((await activeTabInfo(world.chrome)).title).not.toBe('direct')
  expect(world.decoy.hits() + world.real.hits(), 'nothing arrived anywhere').toBe(0)
  expect(await world.app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/'))).not.toBe('DIRECT')
  await shoot(world.app, world.chrome, sheet, 'private-window-nym-closed')
}, 4 * QA_TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('"Open another private window" on the Private page of a Nym window opens another Nym window', async () => {
  const world = await launchHeld(false)
  const priv = await openPage(world.app, world.chrome, 'private')
  await priv.waitForSelector('button.primary')
  const before = new Set(processesWith('--orivon-private-dir=', FLAG))
  await priv.locator('button.primary').click()
  expect(await waitFor(() => processesWith('--orivon-private-dir=', FLAG).some((pid) => !before.has(pid)))).toBe(true)
  peerPids.push(...processesWith('--orivon-private-dir=', FLAG))
}, 4 * QA_TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('the command starts a process that knows it is held from its first instant, on a settings copy that holds the tunnel, and the opening window\'s settings do not change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-private-nym-opener-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const { app, chrome } = await launchShell({ seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(CONTRARY)) } })
  cleanups.push(async () => { await closeElectron(app) })
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
  const before = readFileSync(join(userData, 'settings.json'), 'utf8')
  // The row of the main menu, right after the ordinary private window, with its key; pressing it is the command.
  await chrome.click('#menu')
  const menuPage = (): Page | undefined => app.windows().find((w) => w.url().includes('overlay=menu') && !w.isClosed())
  expect(await waitFor(() => menuPage() !== undefined)).toBe(true)
  const menu = menuPage() as Page
  await menu.waitForSelector('.menu-row')
  const labels = await menu.locator('.menu-row .menu-label').allTextContents()
  expect(labels.indexOf('Open a private window with Nym')).toBe(labels.indexOf('New private window') + 1)
  const row = menu.locator('.menu-row', { hasText: 'Open a private window with Nym' })
  expect(await row.locator('.menu-keys').textContent()).toBe(shownBinding(bindingOf('window.newPrivateNym')))
  await shoot(app, chrome, menu, 'private-window-nym-menu')
  await row.click()

  let peer: ReturnType<typeof privatePeer>
  expect(await waitFor(() => { peer = privatePeer(userData); return peer !== undefined })).toBe(true)
  const found = peer as NonNullable<ReturnType<typeof privatePeer>>
  peerPids.push(...found.pids)
  expect(found.command, 'the process is told on its command line').toContain(FLAG)
  const copy = JSON.parse(readFileSync(join(found.dir, 'settings.json'), 'utf8')) as { version: number, values: Record<string, unknown> }
  expect(copy.values).toMatchObject({ 'network.tunnel.everywhere': true, 'network.route.kind': 'nym', 'network.nym.enabled': true, 'appearance.theme': 'dark' })
  expect(existsSync(join(found.dir, 'bookmarks.json'))).toBe(false)
  expect(await waitFor(() => existsSync(join(found.dir, '.orivon-private.json')), 30_000), 'it started').toBe(true)
  // The window that opened it is as it was.
  expect(readFileSync(join(userData, 'settings.json'), 'utf8')).toBe(before)
  expect(await app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/'))).toBe('DIRECT')
  await delay(200)
}, 4 * QA_TEST_TIMEOUT_MS)
