// The client-certificate chooser in the running shell. A machine with no client certificate cannot be made to
// ask for one in a test, so the app's own `select-client-certificate` event is emitted from main with
// certificates of the shape Electron hands over: what is under test is the listener, the sheet and the answer it
// gives Electron's callback. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { overlayShown, safely, shoot, waitOverlay } from './support/auth-support.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from './support/qa-helpers.js'
import type { FixtureServer } from './support/qa-helpers.js'
import { waitFor } from './support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
let fixture: FixtureServer

beforeAll(async () => { fixture = await startServer((_request, response) => { html(response, '<!doctype html><title>Needs a certificate</title><h1>mTLS</h1>') }) })
afterAll(async () => {
  await fixture.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const DAY = 86_400
const CERTIFICATES = [
  { subjectName: 'Alice Example', issuerName: 'Example Corporate CA', validExpiry: Math.floor(Date.now() / 1000) + 400 * DAY },
  { subjectName: 'alice@personal.example with a rather long subject name that has to be cut off at the edge', issuerName: 'Personal Mail CA', validExpiry: Math.floor(Date.now() / 1000) + 30 * DAY },
  { subjectName: 'Old Service Account', issuerName: 'Retired CA', validExpiry: Math.floor(Date.now() / 1000) - 10 * DAY }
].map((certificate) => ({ ...certificate, subject: { organizations: [] }, issuer: { organizations: [] }, data: '', fingerprint: '', serialNumber: '' }))

/** Emits the event the way Electron does, with `count` of the certificates and, unless `noTab`, the page's own web contents. */
async function ask (app: ElectronApplication, count: number, noTab = false): Promise<void> {
  await app.evaluate(({ app: electron, webContents }, [list, withoutTab]) => {
    const holder = globalThis as unknown as { __picked: unknown[][], __prevented: boolean }
    holder.__picked = []
    holder.__prevented = false
    const tab = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http://127.0.0.1'))
    electron.emit('select-client-certificate',
      { preventDefault: () => { holder.__prevented = true } },
      withoutTab ? null : tab, 'https://mtls.test:8443/login', list,
      (...args: Array<{ subjectName?: string } | undefined>) => { holder.__picked.push(args.map((certificate) => certificate?.subjectName ?? null)) })
  }, [CERTIFICATES.slice(0, count), noTab] as const)
}

const picked = async (app: ElectronApplication): Promise<unknown[][]> =>
  await app.evaluate(() => (globalThis as unknown as { __picked: unknown[][] }).__picked)
const prevented = async (app: ElectronApplication): Promise<boolean> =>
  await app.evaluate(() => (globalThis as unknown as { __prevented: boolean }).__prevented)

async function open (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const shell = await launchShell()
  await visit(shell.app, shell.chrome, `${fixture.origin}/`)
  return shell
}

it('lists the offered certificates and sends the one chosen with the keyboard', async () => {
  const { app, chrome } = await open()
  try {
    await ask(app, 3)
    expect(await prevented(app)).toBe(true)
    const sheet = await waitOverlay(app, 'chooser')
    await sheet.waitForSelector('.listbox-item')
    expect(await sheet.locator('.sheet-title').innerText()).toBe('Choose a certificate')
    expect(await sheet.locator('.origin').innerText()).toBe('mtls.test:8443')
    expect(await sheet.locator('.chooser-line').innerText()).toBe('This site asks you to identify yourself with a certificate.')
    const rows = await sheet.locator('.listbox-item').allInnerTexts()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('Alice Example')
    expect(rows[0]).toContain('Issued by Example Corporate CA')
    expect(rows[0]).toMatch(/Expires/)
    expect(rows[2]).toMatch(/Expired/)
    // An expired certificate is drawn as a problem, and choosing it is warned about under the list.
    expect(await sheet.locator('.listbox-item .badge.danger').count()).toBe(1)
    expect(await sheet.locator('.chooser-caution').isVisible()).toBe(false)
    expect(await sheet.locator('button:has-text("Use certificate")').isDisabled()).toBe(true)
    expect(await sheet.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('listbox')
    await shoot(app, chrome, sheet, 'chooser-none-selected')

    await sheet.keyboard.press('ArrowDown')
    expect(await sheet.locator('.listbox-item[aria-selected="true"]').count()).toBe(1)
    await sheet.keyboard.press('ArrowDown')
    await sheet.keyboard.press('End')
    await sheet.keyboard.press('Home')
    await sheet.keyboard.press('ArrowDown')
    expect(await sheet.locator('.listbox-item').nth(1).getAttribute('aria-selected')).toBe('true')
    expect(await sheet.locator('button:has-text("Use certificate")').isDisabled()).toBe(false)
    await shoot(app, chrome, sheet, 'chooser-selected')
    // Nothing is sent until the choice is confirmed.
    expect(await picked(app)).toEqual([])
    await safely(sheet.keyboard.press('Enter'))
    expect(await waitFor(async () => (await picked(app)).length === 1)).toBe(true)
    expect(await picked(app)).toEqual([[CERTIFICATES[1]?.subjectName]])
    expect(await waitFor(async () => !(await overlayShown(app, 'chooser')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('sends the row that was double-clicked, and none when the sheet is cancelled or dismissed', async () => {
  const { app } = await open()
  try {
    await ask(app, 2)
    let sheet = await waitOverlay(app, 'chooser')
    await sheet.waitForSelector('.listbox-item')
    await safely(sheet.locator('.listbox-item').nth(0).dblclick())
    expect(await waitFor(async () => (await picked(app)).length === 1)).toBe(true)
    expect(await picked(app)).toEqual([[CERTIFICATES[0]?.subjectName]])
    expect(await waitFor(async () => !(await overlayShown(app, 'chooser')))).toBe(true)

    await ask(app, 2)
    sheet = await waitOverlay(app, 'chooser')
    await sheet.waitForSelector('.listbox-item')
    await safely(sheet.click('button:has-text("Cancel")'))
    expect(await waitFor(async () => (await picked(app)).length === 1)).toBe(true)
    expect(await picked(app)).toEqual([[]])

    await ask(app, 2)
    sheet = await waitOverlay(app, 'chooser')
    await sheet.waitForSelector('.listbox-item')
    await safely(sheet.keyboard.press('Escape'))
    expect(await waitFor(async () => (await picked(app)).length === 1)).toBe(true)
    expect(await picked(app)).toEqual([[]])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('sends no certificate, and shows nothing, for a request with no tab or with nothing to offer', async () => {
  const { app } = await open()
  try {
    await ask(app, 2, true)
    expect(await prevented(app)).toBe(true)
    expect(await picked(app)).toEqual([[]])
    await ask(app, 0)
    expect(await picked(app)).toEqual([[]])
    expect(await overlayShown(app, 'chooser')).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
