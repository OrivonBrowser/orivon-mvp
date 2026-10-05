// The Settings sections that report on and control what is particular to
// Orivon: the apps that hold permissions and taking one back, the Ethereum light
// client and its switch, usage statistics (off until chosen, the exact text
// shown), and looking for updates (off until turned on).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const TEST_TIMEOUT_MS = 60_000

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function openSettings (app: ElectronApplication, chrome: Page, path: string): Promise<Page> {
  await chrome.evaluate((at) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', at) }, path)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('.layout')
  return page
}

const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.settings-sections-e2e',
    name: 'Settings sections e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: [],
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
}

it('lists an app that holds a permission with what it has stored, and takes the permission back', async () => {
  const { app, chrome } = await launched()
  try {
    const origin = 'http://127.0.0.1:47391'
    const registered = await app.evaluate(async (_electron, request: DevGrantRequest) => {
      const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
      if (typeof hook !== 'function') return false
      await hook(request)
      return true
    }, { origin, manifest: manifest(), capability: 'tcp.connect', patterns: ['127.0.0.1:9'] } satisfies DevGrantRequest)
    expect(registered).toBe(true)

    const page = await openSettings(app, chrome, '/apps')
    await page.waitForSelector('.app-card')
    const card = page.locator('.app-card', { hasText: '127.0.0.1:47391' })
    expect(await card.locator('.muted').first().textContent()).toContain('Settings sections e2e fixture')
    expect(await card.locator('.app-stored').textContent()).toContain('Stores 0 bytes of files')
    expect(await card.locator('.perm').count()).toBe(1)
    // No keyring under the test's password store: the identity key is remade on each start.
    expect(await page.locator('#row-apps-identity .value').textContent()).toContain('Made again each time')

    await card.locator('.perm button', { hasText: 'Revoke' }).click()
    expect(await waitFor(async () => (await card.locator('.perm').count()) === 0)).toBe(true)
    expect(await card.textContent()).toContain('Nothing is granted to it now.')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says how the light client is, and shows its switch off and out of reach while this run has it forced off', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openSettings(app, chrome, '/web3')
    await page.waitForSelector('#row-web3-light-client')
    // Every test launch forces the light client off (launch-electron.mjs), whatever the stored choice says.
    await page.waitForSelector('#row-web3-forced-off')
    expect(await page.locator('#row-web3-forced-off .value').textContent()).toBe('Off for this run')
    const toggle = page.locator('#row-web3-light-client input[type=checkbox]')
    expect(await toggle.isDisabled()).toBe(true)
    expect(await toggle.isChecked()).toBe(false)
    // The sentence only, with no machine word in front of it.
    const state = (await page.locator('#row-web3-state .value').textContent()) ?? ''
    expect(state).toMatch(/^[A-Z]/)
    expect(state).not.toMatch(/^[a-z]+: /)
    expect(await page.locator('#row-web3-servers .value').textContent()).toContain('https://')
    // A restart inherits the forced switch, so none is offered.
    expect(await page.locator('#row-web3-restart').count()).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows usage statistics as undecided with the exact text that would be sent, and records a choice either way', async () => {
  const { app, chrome } = await launched()
  try {
    const userData = await userDataOf(app)
    const page = await openSettings(app, chrome, '/privacy')
    const row = page.locator('#row-usage-statistics')
    await row.waitFor()
    await page.waitForSelector('#row-usage-statistics .usage')
    expect(await row.locator('.muted').first().textContent()).toContain('You have not chosen')
    // Neither button is the chosen one.
    expect(await row.locator('.usage-buttons .btn.primary').count()).toBe(0)
    await row.locator('summary', { hasText: 'The exact text' }).click()
    const json = JSON.parse(await row.locator('pre.json').first().textContent() ?? '{}') as Record<string, unknown>
    expect(Object.keys(json).sort()).toEqual(['country', 'installId', 'perApp', 'period', 'version'])

    await row.locator('button', { hasText: 'Keep on' }).click()
    await page.waitForFunction(() => document.querySelector('#row-usage-statistics .muted')?.textContent?.startsWith('On:') === true)
    expect(await row.locator('.btn.primary').textContent()).toBe('Keep on')
    expect(await waitFor(() => { try { return JSON.parse(readFileSync(join(userData, 'telemetry.json'), 'utf8')).consent === 'accepted' } catch { return false } })).toBe(true)

    await row.locator('button', { hasText: 'Turn off' }).click()
    await page.waitForFunction(() => document.querySelector('#row-usage-statistics .muted')?.textContent?.startsWith('Off:') === true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps looking for updates off until it is turned on', async () => {
  const { app, chrome } = await launched()
  try {
    const userData = await userDataOf(app)
    const page = await openSettings(app, chrome, '/about')
    const toggle = page.locator('#row-updates-check input[type=checkbox]')
    await toggle.waitFor({ state: 'attached' })
    expect(await toggle.isChecked()).toBe(false)
    expect(await page.locator('#row-updates-result').count()).toBe(0)

    await toggle.click()
    expect(await waitFor(() => { try { return (JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { values: Record<string, unknown> }).values['updates.check'] === true } catch { return false } })).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
