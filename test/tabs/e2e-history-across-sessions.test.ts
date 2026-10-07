// A tab keeps its whole back and forward list while it moves between sessions: the web, a cache-served app with a
// partition of its own, the web again, and back into the app's kept view. The toolbar's Back walks every page in
// order and Forward walks back, each page shown in its own session (src/main/shell/tab-outer-history.ts).
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/tabs/e2e-history-across-sessions.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { waitForTab } from '../support/smoke-helpers.mjs'
import { originFromUrl } from '../../src/broker/policy/origin.js'
import { partitionFor } from '../../src/broker/grants/origin-hash.js'
import { bundleTree } from '../../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../../src/loader/cache/node-storage.js'

const APP_TITLE = 'pinned app'
const page = (title: string): string => `<!doctype html><title>${title}</title><body>${title}</body>`

let web: FixtureServer
let appServer: FixtureServer

beforeAll(async () => {
  web = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page(`web ${request.url ?? ''}`))
  })
  // The app's address answers from the network too, so a page that loaded outside the app's session would show this.
  appServer = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page('from the network'))
  })
})

afterAll(async () => {
  await web.close()
  await appServer.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Pins `origin` in the profile and serves it from the cache, as an installed app is: it gets a partition of its own. */
async function installApp (app: ElectronApplication, origin: string): Promise<void> {
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const storage = nodeLoaderStorage(userDataDir)
  const manifest = JSON.stringify({ orivonApiVersion: 0, id: 'app.orivon.history-e2e', name: 'History e2e fixture', version: '1.0.0', entry: 'index.html', capabilities: {} })
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(manifest) },
    { path: '/index.html', content: new TextEncoder().encode(page(APP_TITLE)) }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
  const registered = await app.evaluate(async (_electron, served: string) => {
    const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
    if (typeof hook !== 'function') return false
    await hook(served)
    return true
  }, origin)
  expect(registered, 'the dev-only serve hook (an e2e build)').toBe(true)
}

/** Which session the tab in front shows its page in: the app's partition, or the default one. */
async function sessionOfShown (app: ElectronApplication, url: string, appPartition: string): Promise<string> {
  return await app.evaluate(({ BaseWindow, session }, args: { url: string, appPartition: string }) => {
    const views = BaseWindow.getAllWindows().flatMap((win) => win.contentView.children) as Array<{ webContents?: Electron.WebContents }>
    const shown = views.map((view) => view.webContents).find((wc) => wc !== undefined && !wc.isDestroyed() && wc.getURL() === args.url)
    if (shown === undefined) return 'not shown'
    if (shown.session === session.fromPartition(args.appPartition)) return 'app'
    return shown.session === session.defaultSession ? 'default' : 'other'
  }, { url, appPartition })
}

async function press (chrome: Page, button: '#back' | '#forward', expected: string): Promise<void> {
  await chrome.click(button)
  const landed = await waitForTab(chrome, { address: expected })
  expect(landed.ok, `${button} lands on ${expected}: ${JSON.stringify(landed.info)}`).toBe(true)
}

it('walks the whole list back and forth across the web and an installed app', async () => {
  const { app, chrome } = await launchShell()
  try {
    const appUrl = `${appServer.origin}/`
    const appPartition = partitionFor(originFromUrl(appUrl) as string)
    await installApp(app, originFromUrl(appUrl) as string)
    const [a, b, c] = ['/a', '/b', '/c'].map((path) => `${web.origin}${path}`) as [string, string, string]

    await visit(app, chrome, a)
    await visit(app, chrome, b)
    await visit(app, chrome, appUrl)
    expect(await sessionOfShown(app, appUrl, appPartition)).toBe('app')
    await visit(app, chrome, c)
    await visit(app, chrome, appUrl)
    expect((await waitForTab(chrome, { address: appUrl, title: APP_TITLE, backDisabled: false })).ok).toBe(true)

    await press(chrome, '#back', c)
    expect(await sessionOfShown(app, c, appPartition)).toBe('default')
    await press(chrome, '#back', appUrl)
    expect((await waitForTab(chrome, { title: APP_TITLE })).ok, 'the app page comes from its pin, in its own session').toBe(true)
    expect(await sessionOfShown(app, appUrl, appPartition)).toBe('app')
    await press(chrome, '#back', b)
    await press(chrome, '#back', a)
    expect((await waitForTab(chrome, { address: a, backDisabled: true, forwardDisabled: false })).ok, 'Back ends on the first page').toBe(true)

    await press(chrome, '#forward', b)
    await press(chrome, '#forward', appUrl)
    expect(await sessionOfShown(app, appUrl, appPartition)).toBe('app')
    await press(chrome, '#forward', c)
    await press(chrome, '#forward', appUrl)
    expect((await waitForTab(chrome, { address: appUrl, forwardDisabled: true })).ok, 'Forward ends on the last page').toBe(true)

    // A new page from the middle of the list ends what was ahead of it.
    await press(chrome, '#back', c)
    await visit(app, chrome, `${web.origin}/d`)
    expect((await waitForTab(chrome, { forwardDisabled: true, backDisabled: false })).ok).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
