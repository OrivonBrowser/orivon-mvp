// WebHID with a device attached (ADR-0068): a virtual USB HID device made through Docker and /dev/uhid, seen by
// Chromium's own HID stack. An app that only calls `getDevices()` is asked in its tab to connect the device; Allow
// is remembered and told to the page as a `connect` event; "Not now" keeps the device away; a second serial number
// is a second question; Forget and revoking the grant take the approval back. A website picks in the chooser.
// The specs skip, with the reason on the console, where Docker or /dev/uhid is missing; ORIVON_REQUIRE_VIRTUAL_HID=1
// (CI) turns that into a failure.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-hid-device.test.ts
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { chooserShown, clickRequest, echoRoundTrip, heardEvents, HID_PAGE, listedDevices, openSettings, requestResult, waitChooser } from './hid-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { answerQuestion, questionGone, readQuestion, waitQuestion } from '../support/question-support.js'
import { delay, waitFor } from '../support/smoke-helpers.mjs'
import { startVirtualHidDevice, virtualHidAvailable, type VirtualHidDevice } from '../support/virtual-hid/index.ts'

const HTML = 'text/html; charset=utf-8'
const availability = await virtualHidAvailable()
if (availability !== true && process.env.ORIVON_REQUIRE_VIRTUAL_HID === '1') throw new Error(`virtual HID is required but unavailable: ${availability}`)
if (availability !== true) console.warn(`[e2e-app-hid-device] skipped: ${availability}`)
const test = availability === true ? it : it.skip

const GRANT = { capability: 'devices.hid', patterns: ['vendor=1209'] }
const MANIFEST = (id: string) => appManifest(id, { devices: { hid: [{ vendorId: 0x1209 }] } })

let servers: AppServer[] = []
const devices: VirtualHidDevice[] = []
beforeAll(async () => {
  servers = [await startAppServer({ '/': { type: HTML, body: HID_PAGE } }), await startAppServer({ '/': { type: HTML, body: HID_PAGE } })]
})
afterAll(async () => {
  for (const device of devices.splice(0)) await device.stop().catch(() => {})
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const app = (): AppServer => servers[0] as AppServer
const site = (): AppServer => servers[1] as AppServer

async function plug (serial: string): Promise<VirtualHidDevice> {
  const device = await startVirtualHidDevice({ vendorId: 0x1209, productId: 0x0001, name: 'Test Key', serial })
  devices.push(device)
  return device
}

const unplug = async (device: VirtualHidDevice): Promise<void> => { await device.stop().catch(() => {}) }

/** The page asks for its devices the way an Electron app does, and the person answers the question that follows. */
async function allowFromGetDevices (electron: ElectronApplication, view: Page, label = 'Allow'): Promise<{ message: string, detail: string, buttons: string[] }> {
  const listing = listedDevices(view)
  const question = await readQuestion(await waitQuestion(electron))
  await answerQuestion(electron, label)
  await listing
  return question
}

const heardConnect = async (view: Page): Promise<boolean> => (await heardEvents(view)).some((event) => event.type === 'connect' && event.device?.productName === 'Test Key')

test('[app:app-hid-device-asked-and-announced] an app that only calls getDevices() is asked to connect the device, hears it connect on Allow and can use it; Not now keeps it away', async () => {
  const first = await plug('SN-A')
  const { app: electron, chrome } = await launchShell()
  try {
    await runPhase('app hid ask', async (check) => {
      await grantApp(electron, app().origin, MANIFEST('hid-ask'), [GRANT])
      const view = await visit(electron, chrome, `${app().origin}/`)
      const question = await allowFromGetDevices(electron, view, 'Not now')
      check('[app:app-hid-device-asked-and-announced] the question names the device, its USB ids and the app', /Connect Test Key \(USB 1209:0001\) to Behaviour hid-ask\?/.test(question.message) && question.detail.includes('SN-A'), JSON.stringify(question))
      check('[app:app-hid-device-asked-and-announced] it offers Allow and Not now', question.buttons.join('|') === 'Allow|Not now', question.buttons.join('|'))
      await delay(1_000)
      check('[app:app-hid-device-asked-and-announced] after Not now the device is not listed', (await listedDevices(view)).length === 0)
      check('[app:app-hid-device-asked-and-announced] and it is not asked about again', await questionGone(electron))

      await unplug(first)
    })
  } finally {
    await closeElectron(electron)
  }

  const second = await plug('SN-B')
  const shell = await launchShell()
  try {
    await runPhase('app hid allow', async (check) => {
      await grantApp(shell.app, app().origin, MANIFEST('hid-ask'), [GRANT])
      const view = await visit(shell.app, shell.chrome, `${app().origin}/`)
      await allowFromGetDevices(shell.app, view, 'Allow')
      check('[app:app-hid-device-asked-and-announced] on Allow the page hears navigator.hid connect with that device', await waitFor(async () => await heardConnect(view)), JSON.stringify(await heardEvents(view)))
      const connect = (await heardEvents(view)).find((event) => event.type === 'connect')
      check('[app:app-hid-device-asked-and-announced] the event is a HIDConnectionEvent whose device is set', connect?.constructor === 'HIDConnectionEvent' && connect.device?.vendorId === 0x1209)
      check('[app:app-hid-device-asked-and-announced] getDevices() now lists it', (await listedDevices(view)).join() === 'Test Key')
      check('[app:app-hid-device-asked-and-announced] the page can open it, write a report and read the echo', await echoRoundTrip(view) === 'echo')
    })
  } finally {
    await closeElectron(shell.app)
    await unplug(second)
  }
}, QA_TEST_TIMEOUT_MS * 4)

test('[app:app-hid-approved-device-is-remembered] an approved device is listed after a reload without a question, a second serial number is asked again, and another origin sees neither', async () => {
  const first = await plug('SN-A')
  const { app: electron, chrome } = await launchShell()
  let second: VirtualHidDevice | undefined
  try {
    await runPhase('app hid remembered', async (check) => {
      await grantApp(electron, app().origin, MANIFEST('hid-remember'), [GRANT])
      const view = await visit(electron, chrome, `${app().origin}/`)
      await allowFromGetDevices(electron, view)
      await view.reload()
      await view.waitForLoadState('load')
      check('[app:app-hid-approved-device-is-remembered] after a reload getDevices() lists the device', await waitFor(async () => (await listedDevices(view)).join() === 'Test Key'))
      check('[app:app-hid-approved-device-is-remembered] with no new question', await questionGone(electron))

      second = await plug('SN-B')
      const question = await readQuestion(await waitQuestion(electron))
      check('[app:app-hid-approved-device-is-remembered] a second device of the same model is asked about, by its serial number', question.detail.includes('SN-B') && question.buttons.includes('Allow'), JSON.stringify(question))
      await answerQuestion(electron, 'Not now')
      check('[app:app-hid-approved-device-is-remembered] declining it leaves only the first listed', await waitFor(async () => (await listedDevices(view)).join() === 'Test Key'))

      await grantApp(electron, site().origin, appManifest('hid-other', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const other = await visit(electron, chrome, `${site().origin}/`)
      check('[app:app-hid-approved-device-is-remembered] another origin is not listed the device', (await listedDevices(other)).length === 0)
    })
  } finally {
    await closeElectron(electron)
    await unplug(first)
    if (second !== undefined) await unplug(second)
  }
}, QA_TEST_TIMEOUT_MS * 4)

test('[app:app-hid-device-can-be-forgotten] Forget in Settings and revoking the grant both make the device unlisted and asked about again', async () => {
  const device = await plug('SN-A')
  const { app: electron, chrome } = await launchShell()
  try {
    await runPhase('app hid forget', async (check) => {
      await grantApp(electron, app().origin, MANIFEST('hid-forget'), [GRANT])
      const view = await visit(electron, chrome, `${app().origin}/`)
      await allowFromGetDevices(electron, view)
      const port = new URL(app().origin).port

      const settings = await openSettings(electron, chrome, '/apps')
      await settings.waitForSelector('.app-card')
      const card = settings.locator('.app-card', { hasText: `127.0.0.1:${port}` })
      check('[app:app-hid-device-can-be-forgotten] the app\'s card lists the device', await waitFor(async () => (await card.locator('.perm', { hasText: 'Test Key' }).count()) === 1))
      await card.locator('.perm', { hasText: 'Test Key' }).locator('button', { hasText: 'Forget' }).click()
      check('[app:app-hid-device-can-be-forgotten] Forget removes the row', await waitFor(async () => (await card.locator('.perm', { hasText: 'Test Key' }).count()) === 0))
      await chrome.evaluate(() => { document.querySelectorAll<HTMLElement>('.tab')[0]?.click() })
      check('[app:app-hid-device-can-be-forgotten] the page no longer lists the device', await waitFor(async () => (await listedDevices(view)).length === 0))
      const again = await readQuestion(await waitQuestion(electron))
      check('[app:app-hid-device-can-be-forgotten] and it is asked about again', again.buttons.includes('Allow'))
      await answerQuestion(electron, 'Allow')
      check('[app:app-hid-device-can-be-forgotten] it lists after the new Allow', await waitFor(async () => (await listedDevices(view)).join() === 'Test Key'))

      const page = await openSettings(electron, chrome, '/apps')
      const revokeCard = page.locator('.app-card', { hasText: `127.0.0.1:${port}` })
      await revokeCard.locator('.perm', { hasText: 'USB devices' }).locator('button', { hasText: 'Revoke' }).click()
      check('[app:app-hid-device-can-be-forgotten] revoking the grant removes the device row with it', await waitFor(async () => (await revokeCard.locator('.perm', { hasText: 'Test Key' }).count()) === 0))
      await chrome.evaluate(() => { document.querySelectorAll<HTMLElement>('.tab')[0]?.click() })
      check('[app:app-hid-device-can-be-forgotten] the page lists nothing, and no question follows', await waitFor(async () => (await listedDevices(view)).length === 0) && await questionGone(electron))
    })
  } finally {
    await closeElectron(electron)
    await unplug(device)
  }
}, QA_TEST_TIMEOUT_MS * 4)

test('[app:website-hid-chooser-unless-blocked] a website picks the device in the chooser, keeps it across a reload, and Forget under Sites takes it back', async () => {
  const device = await plug('SN-A')
  const { app: electron, chrome } = await launchShell()
  try {
    await runPhase('website hid pick', async (check) => {
      const view = await visit(electron, chrome, `${site().origin}/`)
      check('[app:website-hid-chooser-unless-blocked] nothing is listed before the person picks', (await listedDevices(view)).length === 0)
      await clickRequest(view)
      const sheet = await waitChooser(electron)
      check('[app:website-hid-chooser-unless-blocked] the chooser lists the device with its USB ids and serial number', await waitFor(async () => (await sheet.locator('.listbox-item').count()) === 1) && /Test Key/.test(await sheet.locator('.listbox-item').first().innerText()) && /1209:0001/.test(await sheet.locator('.listbox-item').first().innerText()) && /SN-A/.test(await sheet.locator('.listbox-item').first().innerText()))
      await sheet.locator('.listbox-item').first().click()
      await sheet.locator('button:has-text("Connect")').click().catch(() => {})
      check('[app:website-hid-chooser-unless-blocked] the pick resolves requestDevice with that device', await requestResult(view) === 'devices:Test Key')
      await view.reload()
      await view.waitForLoadState('load')
      check('[app:website-hid-chooser-unless-blocked] after a reload getDevices() lists it with no chooser', await waitFor(async () => (await listedDevices(view)).join() === 'Test Key') && !await chooserShown(electron))

      const settings = await openSettings(electron, chrome, '/sites')
      await settings.waitForSelector('#row-sites-list .site-item')
      check('[app:website-hid-chooser-unless-blocked] Sites lists the site with a device badge', /1 device allowed/.test(await settings.locator('#row-sites-list .site-badges').first().innerText()))
      await settings.locator('#row-sites-list .site-toggle').first().click()
      await settings.locator('#row-sites-list .site-kinds li', { hasText: 'Test Key' }).locator('button', { hasText: 'Forget' }).click()
      await chrome.evaluate(() => { document.querySelectorAll<HTMLElement>('.tab')[0]?.click() })
      check('[app:website-hid-chooser-unless-blocked] after Forget the page lists nothing', await waitFor(async () => (await listedDevices(view)).length === 0))
    })
  } finally {
    await closeElectron(electron)
    await unplug(device)
  }
}, QA_TEST_TIMEOUT_MS * 4)
