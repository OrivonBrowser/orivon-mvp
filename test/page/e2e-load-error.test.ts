// A page that fails to load gets a sheet over its tab that says so: why, the address, the error's name and Try again.
// A server that comes back loads on Try again; a page that loads, an HTTP error page with a body of its own and the
// tab's next navigation leave no sheet.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { clickAddressBarRetrying, waitForKeyboardAt } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/gone') { html(res, '<!doctype html><title>Gone</title><h1>Not here</h1>', 404); return }
    html(res, '<!doctype html><title>Fine</title><p>fine</p>')
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The newest sheet: a closed sheet's page stays listed, so the first match may be a dead one. */
const sheetPage = (app: ElectronApplication): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=load-error') && !w.isClosed()).at(-1)
const sheetShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=load-error')
const sheetSays = async (app: ElectronApplication, name: string): Promise<boolean> =>
  await sheetShown(app) && await (sheetPage(app)?.locator('.load-error-name').textContent({ timeout: 1_000 }).catch(() => '') ?? '') === name

/** A loopback port nothing listens on, so a load of it is refused until a server takes it. */
async function closedPort (): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  return port
}

it('says a page failed to load and why, with Try again focused, and loads it once the server is back', async () => {
  const { app, chrome } = await launchShell()
  try {
    await clickAddressBarRetrying(chrome, 'http://unresolvable.invalid/')
    expect((await waitForTab(chrome, { address: 'http://unresolvable.invalid/' })).ok).toBe(true)
    expect(await waitFor(async () => await sheetSays(app, 'ERR_NAME_NOT_RESOLVED'))).toBe(true)
    const sheet = sheetPage(app) as Page
    expect(await sheet.locator('.sheet-title').textContent()).toBe('This site can\'t be reached')
    expect(await sheet.locator('.load-error-text').textContent()).toBe('No server answers to this name. Check the address for a typing mistake.')
    expect(await sheet.locator('.load-error-address').getAttribute('title')).toContain('unresolvable.invalid')
    expect(await sheet.locator('.load-error .btn').allTextContents()).toEqual(['Try again'])
    expect(await waitForKeyboardAt(app, 'overlay=load-error')).toBe(true)
    expect(await sheet.evaluate(() => document.activeElement?.textContent)).toBe('Try again')

    // A server that is down: refused, then up again, and Try again loads it.
    const port = await closedPort()
    const url = `http://127.0.0.1:${String(port)}/`
    await clickAddressBarRetrying(chrome, url)
    expect((await waitForTab(chrome, { address: url })).ok).toBe(true)
    expect(await waitFor(async () => await sheetSays(app, 'ERR_CONNECTION_REFUSED'))).toBe(true)
    expect(await sheetPage(app)?.locator('.load-error-text').textContent()).toBe('The server refused the connection.')
    const late = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Back up</title><p>up</p>') })
    await new Promise<void>((resolve) => { late.listen(port, '127.0.0.1', resolve) })
    try {
      await sheetPage(app)?.click('.load-error .btn')
      expect((await waitForTab(chrome, { address: url, title: 'Back up' })).ok).toBe(true)
      await delay(ABSENCE_SETTLE_MS)
      expect(await sheetShown(app)).toBe(false)
    } finally {
      late.closeAllConnections()
      await new Promise<void>((resolve) => { late.close(() => { resolve() }) })
    }
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('leaves no sheet on an HTTP error page, and takes it away when the tab goes somewhere else', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${server.origin}/gone`)
    await delay(ABSENCE_SETTLE_MS)
    expect(await sheetShown(app)).toBe(false)

    await clickAddressBarRetrying(chrome, 'http://unresolvable.invalid/')
    expect(await waitFor(async () => await sheetSays(app, 'ERR_NAME_NOT_RESOLVED'))).toBe(true)
    await visit(app, chrome, `${server.origin}/`)
    await delay(ABSENCE_SETTLE_MS)
    expect(await sheetShown(app)).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
