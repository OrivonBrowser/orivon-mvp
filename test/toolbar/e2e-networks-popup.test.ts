// The Available networks popup in the running shell: it lists the four nodes Orivon runs on this computer, each with
// its status and a switch; a switch writes the setting Settings uses for the same thing, so Settings shows it moved;
// the light client's switch is fixed while the run forces it off; and the dot on the toolbar button says nothing runs
// while no node does. The popup's lifecycle (Escape, a click away, reopening after a crash) is in
// e2e-toolbar-popups.test.ts. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/toolbar/e2e-networks-popup.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { shoot } from '../support/auth-support.js'
import { evaluateRetrying, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const popupOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/renderer/networks/index.html') && !w.isClosed())

async function openPopup (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.locator('#networks-btn').click()
  expect(await waitFor(() => popupOf(app) !== undefined)).toBe(true)
  const popup = popupOf(app) as Page
  await popup.waitForSelector('.card')
  return popup
}

interface CardRead { readonly id: string, readonly name: string, readonly status: string, readonly on: boolean, readonly disabled: boolean, readonly note: string }

async function cards (popup: Page): Promise<CardRead[]> {
  return await evaluateRetrying(popup, () => Array.from(document.querySelectorAll<HTMLElement>('.card')).map((card) => {
    const control = card.querySelector<HTMLButtonElement>('.switch')
    return {
      id: card.dataset['id'] ?? '',
      name: card.querySelector('.card-name')?.textContent ?? '',
      status: card.querySelector('.card-status')?.textContent ?? '',
      on: control?.getAttribute('aria-checked') === 'true',
      disabled: control?.disabled ?? false,
      note: card.querySelector('.card-note')?.textContent ?? ''
    }
  }))
}

const cardOf = async (popup: Page, id: string): Promise<CardRead | undefined> => (await cards(popup)).find((card) => card.id === id)

async function settingsFile (app: ElectronApplication): Promise<Record<string, unknown>> {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  try {
    const parsed = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { values?: Record<string, unknown>, settings?: Record<string, unknown> }
    return parsed.values ?? parsed.settings ?? parsed
  } catch {
    return {}
  }
}

it('lists the four nodes in order, each with a status word and a switch, under a heading and one plain line', async () => {
  const { app, chrome } = await launchShell()
  try {
    const popup = await openPopup(app, chrome)
    expect(await popup.locator('h1').textContent()).toBe('Available networks')
    expect(await popup.locator('.subtitle').textContent()).toContain('so pages load without a company\'s server in between')
    const read = await cards(popup)
    expect(read.map((card) => card.name)).toEqual(['Ethereum light client', 'IPFS node', 'Swarm node', 'Nym tunnel'])
    for (const card of read) expect(['Running', 'Starting', 'Syncing', 'Asleep', 'Off', 'Not running']).toContain(card.status)
    expect(await popup.locator('.card .switch').count()).toBe(4)
    expect(await chrome.locator('#networks-btn .networks-dot').getAttribute('data-dot')).toBe('none')
    // Set ORIVON_UI_SHOTS_DIR to also photograph the popup in both colour schemes.
    await shoot(app, chrome, popup, 'networks-popup')
    await shoot(app, chrome, chrome, 'networks-toolbar')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('says the light client is off and fixes its switch while the run forces it off', async () => {
  const { app, chrome } = await launchShell()
  try {
    const popup = await openPopup(app, chrome)
    expect(await cardOf(popup, 'light-client')).toMatchObject({ status: 'Off', on: false, disabled: true, note: expect.stringContaining('started with the light client switched off') as string })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('moves the IPFS, Swarm and Nym switches by the settings Settings uses, and Settings shows them moved', async () => {
  const { app, chrome } = await launchShell()
  try {
    const popup = await openPopup(app, chrome)
    expect((await cardOf(popup, 'ipfs'))?.on).toBe(true)

    await popup.locator('.card[data-id="ipfs"] .switch').click()
    expect(await waitFor(async () => (await cardOf(popup, 'ipfs'))?.on === false)).toBe(true)
    expect(await cardOf(popup, 'ipfs')).toMatchObject({ status: 'Off', note: expect.stringContaining('public gateways') as string })
    expect(await waitFor(async () => (await settingsFile(app))['web3.ipfsSource'] === 'gateways')).toBe(true)

    await popup.locator('.card[data-id="swarm"] .switch').click()
    expect(await waitFor(async () => (await cardOf(popup, 'swarm'))?.on === false)).toBe(true)
    expect(await waitFor(async () => (await settingsFile(app))['web3.swarmNode'] === false)).toBe(true)

    await popup.locator('.card[data-id="nym"] .switch').click()
    expect(await waitFor(async () => (await cardOf(popup, 'nym'))?.on === false)).toBe(true)
    expect(await cardOf(popup, 'nym')).toMatchObject({ status: 'Off', note: expect.stringContaining('not sent directly') as string })
    expect(await waitFor(async () => (await settingsFile(app))['network.nym.enabled'] === false)).toBe(true)

    // Settings is the other door to the same three settings: it shows them where the popup left them.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings') && !w.isClosed()))).toBe(true)
    const settings = app.windows().find((w) => w.url().startsWith('orivon://settings') && !w.isClosed()) as Page
    await settings.waitForSelector('#row-web3-swarm-enabled')
    expect(await settings.locator('#row-web3-swarm-enabled input').isChecked()).toBe(false)
    expect(await settings.locator('#row-web3-ipfs-source select').inputValue()).toBe('gateways')

    // Moving it back from the popup is as good as from Settings.
    await chrome.evaluate(() => { document.querySelectorAll<HTMLElement>('.tab')[0]?.click() })
    await chrome.locator('#networks-btn').click()
    const again = await waitFor(() => popupOf(app) !== undefined)
    expect(again).toBe(true)
    const reopened = popupOf(app) as Page
    await reopened.waitForSelector('.card')
    await reopened.locator('.card[data-id="swarm"] .switch').click()
    expect(await waitFor(async () => (await cardOf(reopened, 'swarm'))?.on === true)).toBe(true)
    // Back at its default, the setting is no longer kept in the file at all.
    expect(await waitFor(async () => (await settingsFile(app))['web3.swarmNode'] === undefined)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
