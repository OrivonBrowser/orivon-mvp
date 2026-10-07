// A tab on an `ipfs://` page shows the icon the page declares. The page runs at
// `https://<cid>.ipfs.orivon`, served by the verifier from blocks it checked, so its icon
// must come the same way. Driven through the test seam's gateway, so nothing leaves the machine.
import { randomBytes } from 'node:crypto'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, mainOutput, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { originHash } from '../../src/broker/grants/origin-hash.js'
import { answerEveryQuestion, stubNativeDialogs } from '../support/question-support.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const OTHER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const tabIcon = async (chrome: import('playwright').Page): Promise<string | null> => await chrome.evaluate(() => document.querySelector('.tab.active .fav img')?.getAttribute('src') ?? null)
const dataUrlOf = (bytes: Buffer): string => `data:image/png;base64,${bytes.toString('base64')}`
const hasIcon = async (chrome: import('playwright').Page, bytes: Buffer = PNG): Promise<boolean> => await tabIcon(chrome) === dataUrlOf(bytes)

it('shows the icon an ipfs:// page declares in its tab', async () => {
  await runPhase('ipfs-favicon', async (check) => {
    const gateway = await startFixtureGateway({
      site: {
        'index.html': '<!doctype html><meta charset="utf-8"><title>icon fixture</title><link rel="icon" href="assets/icon.png"><body>icon</body>',
        'assets/icon.png': PNG
      }
    })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}), ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      const loaded = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'icon fixture' })
      check(`the page loaded (${JSON.stringify(loaded.info)})`, loaded.ok)
      const shown = await waitFor(async () => await hasIcon(chrome), 15_000)
      check(`the tab shows the page's own icon (gateway asked ${JSON.stringify(gateway.requests)})`, shown)
      expect(loaded.ok).toBe(true)
      expect(shown).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)

const MANIFEST = { orivonApiVersion: 0, id: 'ipfs.orivon.icons', name: 'Ipfs icons', version: '1.0.0', entry: 'index.html', assets: ['other.html', 'assets/icon.png', 'assets/other.png'], capabilities: { fs: { quotaBytes: 1_048_576 } } }

it('shows the icon a page of an installed ipfs:// app declares, with the gateway gone', async () => {
  await runPhase('ipfs-favicon-installed', async (check) => {
    const gateway = await startFixtureGateway({
      site: {
        'index.html': '<!doctype html><meta charset="utf-8"><title>icon app</title><link rel="icon" href="assets/icon.png"><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>icon</body>',
        'other.html': '<!doctype html><meta charset="utf-8"><title>other page</title><link rel="icon" href="assets/other.png"><body>other</body>',
        'assets/icon.png': PNG,
        'assets/other.png': OTHER_PNG,
        '.well-known/orivon.json': JSON.stringify(MANIFEST)
      }
    })
    const site = gateway.roots['site']!
    let gatewayClosed = false
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}), ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
      })
      const running = app
      await stubNativeDialogs(running)
      answerEveryQuestion(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const pinFile = join(userData, 'apps', originHash(`https://${site}.ipfs.orivon`), 'pin.json')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      const loaded = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'icon app' })
      const pinned = await waitFor(() => existsSync(pinFile), 25_000)
      // The consent question is answered, and the tab reloaded as the app's own, before the next address is typed.
      const reloaded = await waitFor(() => mainOutput(running).includes('reloading the tab that reported it'), 25_000)
      check(`the app installed (${JSON.stringify(loaded.info)})`, loaded.ok && pinned && reloaded)
      await gateway.close()
      gatewayClosed = true

      await clickAddressBarRetrying(chrome, `ipfs://${site}/other.html`)
      const other = await waitForTab(chrome, { address: `ipfs://${site}/other.html`, title: 'other page' })
      check(`its other page opened from the pin (${JSON.stringify(other.info)})`, other.ok)
      const shown = await waitFor(async () => await hasIcon(chrome, OTHER_PNG), 15_000)
      check('the tab shows that page\'s own icon, served from the pin', shown)
      expect(other.ok).toBe(true)
      expect(shown).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (!gatewayClosed) await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)

it('shows the icon of an ipfs:// page when the gateway answers slowly', async () => {
  await runPhase('ipfs-favicon-slow', async (check) => {
    const gateway = await startFixtureGateway({
      site: {
        'index.html': '<!doctype html><meta charset="utf-8"><title>slow icon fixture</title><link rel="icon" href="a/b/icon.png"><body>icon</body>',
        'a/b/icon.png': PNG
      }
    }, { blockDelayMs: 3_000 })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}), ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      // Every block waits blockDelayMs, and the page needs the root and index.html in turn before it commits.
      const loaded = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'slow icon fixture' }, 40_000)
      check(`the page loaded (${JSON.stringify(loaded.info)})`, loaded.ok)
      const shown = await waitFor(async () => await hasIcon(chrome), 40_000)
      check(`the tab shows the page's own icon (gateway asked ${String(gateway.requests.length)} times)`, shown)
      expect(shown).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS + 60_000)

const CONCURRENT_FILES = 8

it('shows the icon of an ipfs:// page while the page itself is loading large files from the same host', async () => {
  await runPhase('ipfs-favicon-busy-page', async (check) => {
    const files: Record<string, string | Uint8Array> = {
      'index.html': `<!doctype html><meta charset="utf-8"><title>busy fixture</title><link rel="icon" href="install/public/favicon.ico"><body>busy<script>for (let i = 0; i < ${String(CONCURRENT_FILES)}; i++) fetch('big' + String(i) + '.bin').then((r) => r.arrayBuffer())</script></body>`,
      'install/public/favicon.ico': PNG
    }
    for (let i = 0; i < CONCURRENT_FILES; i++) files[`big${String(i)}.bin`] = randomBytes(2 * 1024 * 1024)
    const gateway = await startFixtureGateway({ site: files }, { blockDelayMs: 800 })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}), ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      const loaded = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'busy fixture' })
      check(`the page loaded (${JSON.stringify(loaded.info)})`, loaded.ok)
      const shown = await waitFor(async () => await hasIcon(chrome), 60_000)
      check(`the tab shows the page's own icon (gateway asked ${String(gateway.requests.length)} times)`, shown)
      expect(shown).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS + 90_000)

it('shows the icon of an installed .eth app from its pin after a restart, with its name and the gateway gone', async () => {
  await runPhase('ipfs-favicon-installed-restart', async (check) => {
    const gateway = await startFixtureGateway({
      site: {
        'index.html': '<!doctype html><meta charset="utf-8"><title>icon app</title><link rel="icon" href="assets/icon.png"><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>icon</body>',
        'other.html': '<!doctype html><meta charset="utf-8"><title>other page</title><link rel="icon" href="assets/other.png"><body>other</body>',
        'assets/icon.png': PNG,
        'assets/other.png': OTHER_PNG,
        '.well-known/orivon.json': JSON.stringify(MANIFEST)
      }
    })
    const site = gateway.roots['site']!
    const env = (names: Record<string, string>): Record<string, string> => ({ ORIVON_TEST_ETH_FIXTURES: JSON.stringify(names), ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` })
    const startVerifier = async (running: Awaited<ReturnType<typeof launchElectron>>): Promise<void> => {
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
    }
    let gatewayClosed = false
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let profile: string | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env({ 'icons.eth': `ipfs://${site}` }) })
      const first = app
      await stubNativeDialogs(first)
      answerEveryQuestion(first)
      await startVerifier(first)
      profile = await first.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      const pinFile = join(profile, 'apps', originHash('https://icons.eth'), 'pin.json')
      await waitFor(() => first.windows().length === 2)
      const chrome = findChrome(first)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, 'https://icons.eth/')
      const loaded = await waitForTab(chrome, { title: 'icon app' })
      const pinned = await waitFor(() => existsSync(pinFile), 25_000)
      const reloaded = await waitFor(() => mainOutput(first).includes('reloading the tab that reported it'), 25_000)
      const remembered = await waitFor(async () => await hasIcon(chrome), 15_000)
      check(`the app installed and its first page showed its icon (${JSON.stringify(loaded.info)})`, loaded.ok && pinned && reloaded && remembered)
      app = undefined
      await closeElectronApp(first, APP_CLOSE_RACE_MS, { keepProfile: true })
      await gateway.close()
      gatewayClosed = true

      // The name no longer resolves and the gateway is gone, as when ENS or IPNS cannot answer: the verifier can serve
      // nothing, so the page and its icon both have to come from the pin. The icon history kept for the host is
      // index.html's, so only the pin can give other.html's own.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: env({}), reuseProfile: profile })
      const second = app
      await stubNativeDialogs(second)
      answerEveryQuestion(second)
      await startVerifier(second)
      await waitFor(() => second.windows().length === 2)
      const chromeAgain = findChrome(second)
      await waitForAddressBarStable(chromeAgain)
      await clickAddressBarRetrying(chromeAgain, 'https://icons.eth/other.html')
      const other = await waitForTab(chromeAgain, { title: 'other page' })
      check(`its other page opened from the pin (${JSON.stringify(other.info)})`, other.ok)
      const shown = await waitFor(async () => await hasIcon(chromeAgain, OTHER_PNG), 15_000)
      check(`the tab shows that page's own icon, from the pin (shown: ${String(await tabIcon(chromeAgain))})`, shown)
      expect(other.ok).toBe(true)
      expect(shown).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (!gatewayClosed) await gateway.close()
      if (profile !== undefined) await rm(profile, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS * 2)
