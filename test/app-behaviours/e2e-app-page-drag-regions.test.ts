// What a page that draws its own title bar can count on: a control inside an element the page marks
// `-webkit-app-region: drag` still receives a real mouse press as a click, in an app tab and on a website, and
// so does one inside a region the page marks after it loaded. The window's frame belongs to the shell, so a
// page's drag region never takes a press for a window drag. The press is a real pointer on the virtual
// display: a debugger's click skips the window's hit test, which is where a drag region swallows it.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-page-drag-regions.test.ts
import type { ElectronApplication, Frame, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { underVirtualDisplay } from '../support/focus-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { pressPointer } from '../support/native-pointer.js'
import { launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const HTML = 'text/html; charset=utf-8'

/** The page's own files: a served policy refuses inline script, so the script and the stylesheet are same-origin files. */
const PAGE = '<!doctype html><title>drag regions</title><link rel="stylesheet" href="/page.css"><div id="bar"><button id="inside">inside a drag region</button></div><div id="late"><button id="later">in a region marked later</button></div><script src="/page.js"></script>'
const STYLE = `
  body { margin: 0 }
  #bar { position: fixed; top: 0; left: 0; width: 100%; height: 80px; -webkit-app-region: drag }
  #late { position: fixed; top: 100px; left: 0; width: 100%; height: 80px }
  button { width: 220px; height: 50px; margin: 15px }`
/** One header is a drag region from its stylesheet, the other is marked after load with !important. */
const SCRIPT = `
  window.__clicks = []
  for (const id of ['inside', 'later']) document.getElementById(id).addEventListener('click', () => { window.__clicks.push(id) })
  document.getElementById('late').style.setProperty('-webkit-app-region', 'drag', 'important')`
const FILES: Record<string, { type: string, body: string }> = {
  '/': { type: HTML, body: PAGE },
  '/page.css': { type: 'text/css', body: STYLE },
  '/page.js': { type: 'text/javascript', body: SCRIPT },
  '/framed': { type: HTML, body: '<!doctype html><title>framed</title><iframe src="/" style="position:fixed;top:0;left:0;width:100%;height:100%;border:0"></iframe>' }
}

let appServer: AppServer
let website: FixtureServer
beforeAll(async () => {
  appServer = await startAppServer(FILES)
  website = await startServer((request, response) => {
    const file = FILES[request.url ?? '/'] ?? FILES['/'] as { type: string, body: string }
    response.setHeader('content-type', file.type)
    response.end(file.body)
  })
})
afterAll(async () => {
  await appServer.close()
  await website.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Where the page's top-left corner is on the screen: the window's content, plus the view's place in it. */
async function pageOrigin (app: ElectronApplication, origin: string): Promise<{ x: number, y: number }> {
  const at = await app.evaluate(({ BaseWindow }, wanted) => {
    const win = BaseWindow.getAllWindows()[0]
    if (win === undefined) return null
    const content = win.getContentBounds()
    const view = win.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().startsWith(wanted) === true)
    const bounds = view?.getBounds()
    return bounds === undefined ? null : { x: content.x + bounds.x, y: content.y + bounds.y }
  }, origin)
  if (at === null) throw new Error(`no view shows ${origin}`)
  return at
}

/** Presses the centre of `#id` with the real pointer and reports whether the page got the click. */
async function pressAndWatch (app: ElectronApplication, page: Page | Frame, origin: string, id: string): Promise<boolean> {
  const box = await page.locator(`#${id}`).boundingBox()
  if (box === null) throw new Error(`#${id} has no box`)
  const at = await pageOrigin(app, origin)
  pressPointer(at.x + box.x + box.width / 2, at.y + box.y + box.height / 2, 1)
  return await waitFor(async () => await page.evaluate((wanted) => (window as unknown as { __clicks: string[] }).__clicks.includes(wanted), id), 4_000)
}

it('[app:page-drag-region-never-swallows-a-press] a real press on a control inside a page\'s drag region reaches the page, in an app tab and on a website', async () => {
  expect(underVirtualDisplay()).toBe(true)
  const { app, chrome } = await launchShell()
  try {
    await runPhase('page drag regions', async (check) => {
      await grantApp(app, appServer.origin, appManifest('page-drag-regions', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const appPage = await visit(app, chrome, `${appServer.origin}/`)
      const regions = await appPage.evaluate(() => ['bar', 'late'].map((id) => String((getComputedStyle(document.getElementById(id) as Element) as unknown as Record<string, string>)['appRegion'])))
      check('[app:page-drag-region-never-swallows-a-press] the page\'s own declarations, one in a stylesheet and one set later with !important, both compute as no-drag', regions.every((region) => region === 'no-drag'), JSON.stringify(regions))
      check('[app:page-drag-region-never-swallows-a-press] a real press on a button inside an app\'s drag region is a click for the page', await pressAndWatch(app, appPage, appServer.origin, 'inside'))
      check('[app:page-drag-region-never-swallows-a-press] and so is one inside a region the app marked after it loaded', await pressAndWatch(app, appPage, appServer.origin, 'later'))

      await chrome.click('#new-tab')
      const sitePage = await visit(app, chrome, `${website.origin}/`)
      check('[app:page-drag-region-never-swallows-a-press] a real press on a button inside a website\'s drag region is a click for the page', await pressAndWatch(app, sitePage, website.origin, 'inside'))
      check('[app:page-drag-region-never-swallows-a-press] and so is one inside a region the website marked after it loaded', await pressAndWatch(app, sitePage, website.origin, 'later'))

      const framedPage = await visit(app, chrome, `${website.origin}/framed`)
      expect(await waitFor(() => framedPage.frames().some((frame) => frame !== framedPage.mainFrame() && frame.url() === `${website.origin}/`))).toBe(true)
      const inner = framedPage.frames().find((frame) => frame !== framedPage.mainFrame() && frame.url() === `${website.origin}/`) as Frame
      check('[app:page-drag-region-never-swallows-a-press] a real press on a button inside a drag region of a frame embedded in the page is a click for the frame', await pressAndWatch(app, inner, website.origin, 'inside'))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
