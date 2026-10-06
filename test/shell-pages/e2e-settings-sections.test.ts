// The Settings sections that report on and control what is particular to
// Orivon: the apps that hold permissions and taking one back, the Ethereum light
// client and its switch, usage statistics (off until chosen, the exact text
// shown, the switch, Delete my data and the privacy notice), and looking for updates (off until turned on).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { startIngest, telemetryHomeFolder } from '../support/telemetry-ingest.js'
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

async function telemetryOn (home: string, ingestUrl: string): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_TELEMETRY: 'on', ORIVON_TELEMETRY_HOME: home, ORIVON_TELEMETRY_URL: ingestUrl, ORIVON_TELEMETRY_TICK_MS: '60000' }
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const readConsent = (home: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(readFileSync(join(home, 'consent.json'), 'utf8')) as Record<string, unknown> } catch { return undefined }
}

it('says telemetry is off for a launch that has it off, and offers no switch to turn it on', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openSettings(app, chrome, '/privacy')
    const row = page.locator('#row-usage-statistics')
    await row.waitFor()
    await page.waitForSelector('#row-usage-statistics #usage-state')
    expect(await row.locator('#usage-state').textContent()).toContain('turned off for this launch')
    expect(await row.locator('#usage-switch').isDisabled()).toBe(true)
    expect(await row.locator('#usage-delete').count()).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows usage statistics as not chosen yet with the exact text that would be sent, and the switch turns them on and off for the whole computer', async () => {
  const ingest = await startIngest()
  const { home, remove } = await telemetryHomeFolder()
  const { app, chrome } = await telemetryOn(home, ingest.url)
  try {
    const page = await openSettings(app, chrome, '/privacy')
    const row = page.locator('#row-usage-statistics')
    await row.waitFor()
    await page.waitForSelector('#row-usage-statistics #usage-state')
    expect(await row.locator('#usage-state').textContent()).toContain('Not chosen yet')
    expect(await row.locator('#usage-switch').isChecked()).toBe(false)
    expect(await row.locator('#usage-install-id').count()).toBe(0)
    // Nothing was ever sent from this computer, so there is nothing to delete and no button for it.
    expect(await row.locator('#usage-nothing-sent').textContent()).toBe('Nothing has been sent from this computer.')
    expect(await row.locator('#usage-delete').count()).toBe(0)

    await row.locator('summary', { hasText: 'What is sent' }).click()
    const usage = JSON.parse(await row.locator('#usage-json').textContent() ?? '{}') as Record<string, unknown>
    expect(Object.keys(usage).sort()).toEqual(['activeSec', 'backgroundSec', 'classes', 'installId', 'period', 'region', 'schema', 'stream', 'version'])
    expect(usage['installId']).toBe('(made when you turn this on)')
    const sites = JSON.parse(await row.locator('#sites-json').textContent() ?? '{}') as Record<string, unknown>
    expect(Object.keys(sites).sort()).toEqual(['period', 'reportId', 'schema', 'sites', 'version'])
    expect(readConsent(home)).toBeUndefined()

    await row.locator('.switch').click()
    await page.waitForFunction(() => document.querySelector('#usage-state')?.textContent?.startsWith('On.') === true)
    expect(await waitFor(() => readConsent(home)?.['state'] === 'accepted')).toBe(true)
    expect(readConsent(home)).toMatchObject({ source: 'settings', noticeVersion: 2 })
    const installId = await row.locator('#usage-install-id').textContent()
    expect(installId).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(await row.locator('#usage-json').textContent() ?? '{}')).toMatchObject({ installId })

    await row.locator('.switch').click()
    await page.waitForFunction(() => document.querySelector('#usage-state')?.textContent?.startsWith('Off.') === true)
    expect(await waitFor(() => readConsent(home)?.['state'] === 'declined')).toBe(true)
    expect(await row.locator('#usage-install-id').count()).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
    await ingest.close()
    await remove()
  }
}, TEST_TIMEOUT_MS)

it('Delete my data asks the server to erase the install ID, turns telemetry off and says done; and says failed when the server cannot be reached', async () => {
  const ingest = await startIngest()
  const { home, remove } = await telemetryHomeFolder()
  const { app, chrome } = await telemetryOn(home, ingest.url)
  try {
    const page = await openSettings(app, chrome, '/privacy')
    const row = page.locator('#row-usage-statistics')
    await row.waitFor()
    await page.waitForSelector('#row-usage-statistics #usage-state')
    await row.locator('.switch').click()
    await row.locator('#usage-install-id').waitFor()
    await row.locator('#usage-delete').waitFor()
    expect(await row.locator('#usage-nothing-sent').count()).toBe(0)
    const installId = await row.locator('#usage-install-id').textContent()

    await row.locator('#usage-delete').click()
    await page.waitForFunction(() => document.querySelector('#usage-erase')?.textContent?.startsWith('Done.') === true)
    expect(ingest.requests.filter((request) => request.path === '/v1/erase')).toEqual([{ path: '/v1/erase', body: { schema: 2, installId } }])
    expect(readConsent(home)?.['state']).toBe('declined')
    expect(await row.locator('#usage-state').textContent()).toContain('Off.')

    // Deleted, so there is nothing left to delete; turned on again, there is, and the server is now gone.
    expect(await row.locator('#usage-delete').count()).toBe(0)
    await row.locator('.switch').click()
    await row.locator('#usage-delete').waitFor()
    await ingest.close()
    await row.locator('#usage-delete').click()
    await page.waitForFunction(() => document.querySelector('#usage-erase')?.textContent?.startsWith('The request did not reach the server') === true)
  } finally {
    await closeElectron(app)
    await remove()
  }
}, TEST_TIMEOUT_MS)

it('shows the privacy notice from the page itself, with no network, and draws it as text', async () => {
  const ingest = await startIngest()
  const { home, remove } = await telemetryHomeFolder()
  const { app, chrome } = await telemetryOn(home, ingest.url)
  try {
    const page = await openSettings(app, chrome, '/privacy')
    const row = page.locator('#row-usage-statistics')
    await row.waitFor()
    await page.waitForSelector('#row-usage-statistics #usage-notice-toggle')
    expect(await row.locator('.usage-notice').count()).toBe(0)
    await row.locator('#usage-notice-toggle').click()
    await row.locator('.usage-notice').waitFor()
    expect(await row.locator('.usage-notice h4').allTextContents()).toContain('What telemetry sends')
    expect(await row.locator('.usage-notice table td').allTextContents()).toContain('classes.web3')
    expect(await row.locator('.usage-notice img, .usage-notice script, .usage-notice a').count()).toBe(0)
    expect(ingest.requests).toEqual([])
  } finally {
    await closeElectron(app)
    await ingest.close()
    await remove()
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
