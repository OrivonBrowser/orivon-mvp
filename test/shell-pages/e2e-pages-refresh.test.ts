// The shell's own pages follow changes made around them. Clearing cookies and site data from Settings empties the
// "Sites that store data" list above it at once; the Bookmarks page showing a folder that is deleted elsewhere falls
// back to the bookmarks bar and says so in its address.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'kept=1; Path=/; Max-Age=86400' })
    res.end('<!doctype html><title>cookies</title><p>a site that keeps a cookie</p>')
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openInternal (app: ElectronApplication, chrome: Page, page: string, path?: string): Promise<Page> {
  await chrome.evaluate(([p, at]) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal(p as string, at) }, [page, path] as const)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(`orivon://${page}`)))).toBe(true)
  return app.windows().find((w) => w.url().startsWith(`orivon://${page}`)) as Page
}

it('empties the list of sites that store data when Clear data removes cookies and site data', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, `${server.origin}/`)
    const settings = await openInternal(app, chrome, 'settings', '/privacy')
    await settings.waitForSelector('#site-data .sd-site')
    expect(await settings.locator('#site-data .sd-domain').allTextContents()).toContain('127.0.0.1')

    await settings.locator('label.clear-option', { hasText: 'Cookies and site data' }).locator('input').check()
    const clear = settings.locator('.clear-actions button', { hasText: /Clear data|Click again/ })
    await clear.click()
    await clear.click()
    expect(await waitFor(async () => !(await settings.locator('#site-data .sd-domain').allTextContents()).includes('127.0.0.1'))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('moves the Bookmarks page\'s address to the bookmarks bar when the folder it shows is deleted elsewhere', async () => {
  const { app, chrome } = await launchShell()
  try {
    const bookmarks = await openInternal(app, chrome, 'bookmarks')
    const made = await bookmarks.evaluate(async () => await (window as unknown as { orivonInternal: { request: (domain: string, command: unknown) => Promise<unknown> } }).orivonInternal.request('bookmarks', { type: 'addFolder', parent: 'bar', title: 'Gone soon' })) as { id: string }
    await bookmarks.evaluate((path) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')) }, `/folder/${made.id}`)
    expect(await waitFor(async () => await bookmarks.evaluate(() => location.pathname) === `/folder/${made.id}`)).toBe(true)

    await bookmarks.evaluate(async (id) => await (window as unknown as { orivonInternal: { request: (domain: string, command: unknown) => Promise<unknown> } }).orivonInternal.request('bookmarks', { type: 'remove', ids: [id] }), made.id)
    expect(await waitFor(async () => await bookmarks.evaluate(() => location.pathname) === '/')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
