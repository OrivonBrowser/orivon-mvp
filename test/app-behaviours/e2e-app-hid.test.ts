// WebHID for an app and for a website (ADR-0068), with no device attached: what is refused, and what opens a
// chooser. An app without a `devices.hid` grant sees nothing and gets no chooser; an app with one gets Orivon's
// chooser, never Electron's pick of the first device; a website gets the chooser unless its setting is Block. The
// specs that need a device are in e2e-app-hid-device.test.ts.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-hid.test.ts
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { cancelChooser, chooserShown, clickRequest, HID_ROUTES, listedDevices, requestResult, waitChooser } from './hid-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { delay, waitFor } from '../support/smoke-helpers.mjs'


let undeclared: AppServer
let declared: AppServer
let website: AppServer
beforeAll(async () => {
  undeclared = await startAppServer(HID_ROUTES)
  declared = await startAppServer(HID_ROUTES)
  website = await startAppServer(HID_ROUTES)
})
afterAll(async () => {
  await undeclared.close()
  await declared.close()
  await website.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const GENERIC_VENDOR = { capability: 'devices.hid', patterns: ['vendor=1209'] }

it('[app:app-hid-undeclared-is-refused] an app that holds no devices.hid grant sees no device and gets no chooser', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('undeclared app hid', async (check) => {
      await grantApp(app, undeclared.origin, appManifest('hid-undeclared', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${undeclared.origin}/`)
      check('[app:app-hid-undeclared-is-refused] getDevices lists nothing', (await listedDevices(view)).length === 0)
      await clickRequest(view)
      const result = await requestResult(view)
      check('[app:app-hid-undeclared-is-refused] requestDevice settles without a device', result === 'devices:' || result.startsWith('ERR:'), result)
      await delay(1_000)
      check('[app:app-hid-undeclared-is-refused] no chooser was shown', !await chooserShown(app))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)

it('[app:app-hid-declared-opens-the-chooser] an app that declares devices.hid gets Orivon\'s chooser from requestDevice, and Cancel resolves with no device', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('declared app hid', async (check) => {
      await grantApp(app, declared.origin, appManifest('hid-declared', { devices: { hid: [{ vendorId: 0x1209 }] } }), [GENERIC_VENDOR])
      const view = await visit(app, chrome, `${declared.origin}/`)
      check('[app:app-hid-declared-opens-the-chooser] getDevices lists nothing while nothing is attached', (await listedDevices(view)).length === 0)
      await clickRequest(view)
      const sheet = await waitChooser(app)
      check('[app:app-hid-declared-opens-the-chooser] the chooser names the device kind and the page', /device/i.test(await sheet.locator('.sheet-title').innerText()) && (await sheet.locator('.origin').innerText()).includes('127.0.0.1'))
      check('[app:app-hid-declared-opens-the-chooser] it lists no device, because none matches the grant', await sheet.locator('.listbox-item').count() === 0)
      await cancelChooser(sheet)
      const result = await requestResult(view)
      check('[app:app-hid-declared-opens-the-chooser] Cancel resolves requestDevice with no device', result === 'devices:', result)
      check('[app:app-hid-declared-opens-the-chooser] the chooser is gone', await waitFor(async () => !await chooserShown(app)))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)

async function openSettings (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('siteSettings.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings') && !w.isClosed()))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings') && !w.isClosed()) as Page
  await settings.waitForSelector('#row-sites-list .sites-ul:not([aria-busy="true"])')
  return settings
}

it('[app:website-hid-chooser-unless-blocked] a website gets the chooser from requestDevice, and none once the person set USB and HID devices to Block', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('website hid', async (check) => {
      const view = await visit(app, chrome, `${website.origin}/`)
      await view.evaluate(() => { (window as unknown as { __filters: unknown }).__filters = [{ vendorId: 0x1209 }] })
      await clickRequest(view)
      const sheet = await waitChooser(app)
      check('[app:website-hid-chooser-unless-blocked] a website\'s requestDevice opens the chooser', await sheet.locator('.sheet-title').count() === 1)
      await cancelChooser(sheet)
      check('[app:website-hid-chooser-unless-blocked] Cancel resolves with no device', await requestResult(view) === 'devices:')

      const settings = await openSettings(app, chrome)
      await settings.selectOption('#row-sites-devices select', 'block')
      await chrome.evaluate(() => { document.querySelectorAll<HTMLElement>('.tab')[0]?.click() })
      await view.evaluate(() => { (window as unknown as { __r: { req: string | null } }).__r.req = null })
      await clickRequest(view)
      const blocked = await requestResult(view)
      check('[app:website-hid-chooser-unless-blocked] with the setting on Block requestDevice settles without a device', blocked === 'devices:' || blocked.startsWith('ERR:'), blocked)
      await delay(1_000)
      check('[app:website-hid-chooser-unless-blocked] and no chooser was shown', !await chooserShown(app))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 3)
