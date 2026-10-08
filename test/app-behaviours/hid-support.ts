// What the WebHID specs share (ADR-0068): a page that calls `navigator.hid` the way an app does, and the steps that
// drive Orivon's chooser and the per-site setting around it. `requestDevice()` needs a user gesture, so the page asks
// from a click and records what the call settled to.
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { overlayShown, safely, waitOverlay } from '../support/auth-support.js'
import { waitFor } from '../support/smoke-helpers.mjs'

/** Records into `window.__r`: `req` (what the last requestDevice settled to) and `events` (each `connect`/`disconnect` the page heard). */
export const HID_PAGE = `<!doctype html><title>hid</title><body style="font:16px sans-serif">
<button id="req">request</button>
<script>
window.__r = { req: null, events: [] }
window.__filters = [{ vendorId: 0x1209 }]
const describeDevice = (device) => device === null ? null : { vendorId: device.vendorId, productId: device.productId, productName: device.productName }
if (navigator.hid) {
  for (const type of ['connect', 'disconnect']) {
    navigator.hid.addEventListener(type, (event) => { window.__r.events.push({ type, constructor: event.constructor.name, device: describeDevice(event.device) }) })
  }
}
window.__echo = async () => {
  const [device] = await navigator.hid.getDevices()
  if (!device) return 'no device'
  await device.open()
  try {
    const heard = new Promise((resolve) => { device.addEventListener('inputreport', (event) => { resolve(Array.from(new Uint8Array(event.data.buffer))) }, { once: true }) })
    const sent = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
    await device.sendReport(0, sent)
    const back = await Promise.race([heard, new Promise((resolve) => setTimeout(resolve, 10000, null))])
    return back === null ? 'no input report' : (back.length === 64 && back.every((byte, index) => byte === sent[index])) ? 'echo' : 'echo differs: ' + back.slice(0, 8).join(',')
  } finally {
    await device.close()
  }
}
document.getElementById('req').addEventListener('click', async () => {
  window.__r.req = 'pending'
  try {
    const devices = await navigator.hid.requestDevice({ filters: window.__filters })
    window.__r.req = 'devices:' + devices.map((device) => device.productName).join(',')
  } catch (error) {
    window.__r.req = 'ERR:' + error.name
  }
})
</script></body>`

/** The settled result of the last `requestDevice` click, once it is not pending. */
export async function requestResult (view: Page): Promise<string> {
  let result = 'pending'
  expect(await waitFor(async () => {
    result = await view.evaluate(() => String((window as unknown as { __r: { req: string | null } }).__r.req))
    return result !== 'pending' && result !== 'null'
  })).toBe(true)
  return result
}

export const clickRequest = async (view: Page): Promise<void> => { await view.click('#req') }

/** What `navigator.hid.getDevices()` lists now, as product names. */
export async function listedDevices (view: Page): Promise<string[]> {
  return await view.evaluate(async () => (await (navigator as unknown as { hid: { getDevices: () => Promise<Array<{ productName: string }>> } }).hid.getDevices()).map((device) => device.productName))
}

export interface HeardEvent { readonly type: string, readonly constructor: string, readonly device: { vendorId: number, productId: number, productName: string } | null }

export async function heardEvents (view: Page): Promise<HeardEvent[]> {
  return await view.evaluate(() => (window as unknown as { __r: { events: HeardEvent[] } }).__r.events)
}

/** The chooser sheet, once Orivon shows it. */
export async function waitChooser (app: ElectronApplication): Promise<Page> {
  const sheet = await waitOverlay(app, 'chooser')
  await sheet.waitForSelector('.sheet-title')
  return sheet
}

export async function cancelChooser (sheet: Page): Promise<void> {
  await safely(sheet.click('button:has-text("Cancel")'))
}

export async function chooserShown (app: ElectronApplication): Promise<boolean> {
  return await overlayShown(app, 'chooser')
}

/** A write to the open device and the report it sends back: 'echo' when the page got its own 64 bytes. */
export async function echoRoundTrip (view: Page): Promise<string> {
  return await view.evaluate(async () => await (window as unknown as { __echo: () => Promise<string> }).__echo())
}

export async function openSettings (app: ElectronApplication, chrome: Page, path: '/apps' | '/sites'): Promise<Page> {
  await chrome.evaluate((at) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', at) }, path)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings') && !w.isClosed()))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings') && !w.isClosed()) as Page
  await page.waitForSelector('.layout')
  return page
}
