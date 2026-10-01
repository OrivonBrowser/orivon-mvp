// A window shrunk to a narrow width while the main menu is open must leave the
// main process running and the menu closed, and the menu must open again after.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor, waitForTab } from './smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const SILENT = { env: { PULSE_SERVER: 'unix:/nonexistent' }, args: [HERMETIC_RESOLVER, '--alsa-output-device=null'] }

let server: Server
let siteUrl = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>a site</title><h1>a site</h1>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  siteUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const menuPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=menu'))
const menuShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=menu')

async function openMenu (app: App, chrome: Page): Promise<void> {
  await chrome.click('#menu')
  expect(await waitFor(async () => await menuShown(app))).toBe(true)
  expect(await waitFor(() => menuPage(app) !== undefined)).toBe(true)
  await (menuPage(app) as Page).waitForSelector('.menu-row')
}

for (const [width, height] of [[700, 760], [800, 700], [850, 700]] as const) {
  it(`shrinking the window to ${String(width)}x${String(height)} with the menu open keeps the main process alive`, async () => {
    const app = await launchElectron({ appPath: '.', ...SILENT })
    try {
      expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
      const chrome = findChrome(app)
      await clickAddressBarRetrying(chrome, siteUrl)
      expect((await waitForTab(chrome, { address: siteUrl })).ok).toBe(true)
      await openMenu(app, chrome)

      await app.evaluate(({ BaseWindow }, size) => { BaseWindow.getAllWindows()[0]?.setSize(size[0] as number, size[1] as number) }, [width, height])

      expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
      await delay(500)
      expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1)
      expect(mainOutput(app)).not.toContain('uncaught exception')

      await delay(350)
      await openMenu(app, chrome)
    } finally {
      await closeElectron(app)
    }
  }, TEST_TIMEOUT_MS)
}
