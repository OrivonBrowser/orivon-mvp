// Hostile and broken conditions the other specs do not create. Each scenario
// asserts an invariant the product states for itself, never how a failure
// should look: the app starts and works on damaged state, the tab strip and the
// main process never disagree about which tabs exist, one dead renderer does not
// take the shell or its other tabs with it, and the address bar never names a
// page the tab is not on.
//
// Not covered here: malformed calls to `window.orivon.*` (needs the page-script
// and dev-grant machinery of e2e-capability-boundary.test.ts, which already
// holds the permission-boundary assertions), and an uncaught exception in the
// main process (Electron answers it with a blocking error dialog).

import { writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clickAddressBarRetrying, runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { collected, windowGeometry } from '../support/qa-evidence.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, tabIds, tabViews, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

/** Thirty tabs opened or closed in a burst: generous, because a shared CI runner is slower than a desk. */
const SLOW_RUNNER_MS = 30_000

let server: FixtureServer
const hung: ServerResponse[] = []
let hangRequests = 0
beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/hang') { hangRequests++; hung.push(res); return }
    html(res, `<!doctype html><meta charset="utf-8"><title>Page ${req.url ?? ''}</title><h1>Page ${req.url ?? ''}</h1>`)
  })
})
afterAll(async () => {
  for (const res of hung) res.destroy()
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type Shell = { orivonShell: { openInternal: (page: string) => void } }
const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

/** The URL of the tab view the window is showing, read from the main process, never from the address bar. */
async function shownTabUrl (app: ElectronApplication): Promise<string | undefined> {
  const shown = (await windowGeometry(app)).flatMap((w) => w.views).filter((v) => v.visible && !v.url.startsWith('orivon-shell:'))
  return shown[0]?.url
}

describe('damaged profile state: the shell starts and works, never crashes', () => {
  const GARBAGE: Record<string, string | Buffer> = {
    'bookmarks.json': '[{"url": "http://a.example/", "title": "cut off',
    'settings.json': '{"theme": ',
    'shortcuts.json': 'not json at all \u0000\u0001',
    'zoom.json': '[[[[',
    'history.db': Buffer.from('this is not a sqlite database file')
  }
  it.each(Object.keys(GARBAGE))('with a corrupt %s', async (file) => {
    const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await writeFile(join(dir, file), GARBAGE[file] as string | Buffer) } })
    try {
      await runPhase(`corrupt ${file}`, async (check) => {
        check('the dashboard renders', await waitFor(() => dashboardOf(app) !== undefined))
        const fixture = `${server.origin}/ok`
        await visit(app, chrome, fixture)
        check('the address bar navigates to a page', (await waitForTab(chrome, { address: fixture })).ok)

        await chrome.evaluate(() => { (window as unknown as Shell).orivonShell.openInternal('settings') })
        check('orivon://settings opens and loads', await waitFor(async () => {
          const page = app.windows().find((w) => w.url().startsWith('orivon://settings'))
          return page !== undefined && (await page.title()) === 'Settings'
        }))

        if (file === 'bookmarks.json') {
          await visit(app, chrome, fixture)
          await chrome.click('#bookmark-toggle')
          check('a bookmark can still be added over the damaged store', (await waitForTab(chrome, { bookmarked: true })).ok)
        }
        const log = mainOutput(app)
        check('the main process reported no uncaught exception or unhandled rejection', !/uncaught exception|unhandled ?rejection|UnhandledPromiseRejection/i.test(log), log.slice(-300))
        const errors = collected(app)?.pageErrors.filter((e) => !String(e.url).startsWith('http')) ?? []
        check('no shell page threw', errors.length === 0, JSON.stringify(errors).slice(0, 300))
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
})

it('thirty rapid new tabs and thirty rapid closes leave the tab strip and the main process agreeing', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('tab churn', async (check) => {
      expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
      const agree = async (): Promise<{ strip: number, views: number }> => ({ strip: (await tabIds(chrome)).length, views: tabViews(app, chrome).length })

      for (let i = 0; i < 30; i++) await chrome.click('#new-tab')
      check('thirty-one tabs appear in the strip', await waitFor(async () => (await tabIds(chrome)).length === 31, SLOW_RUNNER_MS), String((await tabIds(chrome)).length))
      await delay(ABSENCE_SETTLE_MS)
      const opened = await agree()
      check('the main process holds one view per tab in the strip', opened.strip === opened.views, JSON.stringify(opened))

      for (let i = 0; i < 30; i++) await chrome.click('.tab.active .close')
      check('thirty closes leave exactly one tab', await waitFor(async () => (await tabIds(chrome)).length === 1, SLOW_RUNNER_MS), String((await tabIds(chrome)).length))
      await delay(ABSENCE_SETTLE_MS)
      const closed = await agree()
      check('after closing, the strip and the main process still agree', closed.strip === 1 && closed.views === 1, JSON.stringify(closed))
      const page = `${server.origin}/after-churn`
      await clickAddressBarRetrying(chrome, page)
      check('the last tab still navigates', (await waitForTab(chrome, { address: page })).ok)
      check('no shell page threw during the churn', (collected(app)?.pageErrors.filter((e) => !String(e.url).startsWith('http')) ?? []).length === 0, JSON.stringify(collected(app)?.pageErrors).slice(0, 300))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('a tab whose renderer is killed does not take the shell or the other tabs with it', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('renderer killed', async (check) => {
      const first = `${server.origin}/survivor`
      const doomed = `${server.origin}/doomed`
      await visit(app, chrome, first)
      await chrome.click('#new-tab')
      await visit(app, chrome, doomed)
      const doomedTab = (await activeTabInfo(chrome)).activeId as string

      const osPid = await app.evaluate(({ webContents }, target: string) => webContents.getAllWebContents().find((wc) => wc.getURL() === target)?.getOSProcessId(), doomed)
      expect(osPid).toBeGreaterThan(0)
      // SIGKILL of the real process: forcefullyCrashRenderer() hangs this harness under xvfb.
      process.kill(osPid as number, 'SIGKILL')
      check('the main process saw the renderer go', await waitFor(async () => await app.evaluate(() => ((globalThis as { __orivonQaEvents?: Array<{ kind: string }> }).__orivonQaEvents ?? []).some((e) => e.kind === 'render-process-gone'))))

      check('the main process is still answering', await app.evaluate(() => typeof process.pid === 'number'))
      check('the tab strip still lists both tabs', (await tabIds(chrome)).length === 2, JSON.stringify(await tabIds(chrome)))

      await chrome.click(`.tab:not([data-id="${doomedTab}"])`)
      const elsewhere = `${server.origin}/elsewhere`
      await clickAddressBarRetrying(chrome, elsewhere)
      check('the other tab still navigates', (await waitForTab(chrome, { address: elsewhere })).ok)

      await chrome.hover(`.tab[data-id="${doomedTab}"]`)
      await chrome.click(`.tab[data-id="${doomedTab}"] .close`)
      check('the dead tab can be closed', await waitFor(async () => (await tabIds(chrome)).length === 1), JSON.stringify(await tabIds(chrome)))
      await chrome.click('#new-tab')
      const fresh = `${server.origin}/fresh`
      await clickAddressBarRetrying(chrome, fresh)
      check('a new tab opens and loads after the crash', (await waitForTab(chrome, { address: fresh })).ok)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('a navigation abandoned mid-load, then back and forward hammered, never leaves the address bar on the wrong page', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('navigation aborted', async (check) => {
      const a = `${server.origin}/a`
      const b = `${server.origin}/b`
      await visit(app, chrome, a)
      await clickAddressBarRetrying(chrome, `${server.origin}/hang`)
      check('the hanging load really started', await waitFor(() => hangRequests > 0))

      await clickAddressBarRetrying(chrome, b)
      check('navigating away from the pending load reaches the new page', (await waitForTab(chrome, { address: b })).ok)
      check('no tab is left loading', await waitFor(async () => (await chrome.locator('.tab .fav.loading').count()) === 0))

      await chrome.click('#back')
      check('back returns to the last committed page, not the abandoned one', (await waitForTab(chrome, { address: a })).ok, JSON.stringify((await activeTabInfo(chrome)).address))
      await chrome.click('#forward')
      check('forward returns to the page navigated to', (await waitForTab(chrome, { address: b })).ok)

      for (let i = 0; i < 12; i++) await chrome.click(i % 2 === 0 ? '#back' : '#forward', { force: true, noWaitAfter: true })
      await delay(ABSENCE_SETTLE_MS)
      const info = await activeTabInfo(chrome)
      const shown = await shownTabUrl(app)
      check('after the hammering, the address bar names the page the tab is showing', info.address === shown, `address ${String(info.address)}, tab ${String(shown)}`)
      check('and no tab is left loading', (await chrome.locator('.tab .fav.loading').count()) === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
