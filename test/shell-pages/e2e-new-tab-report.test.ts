// The new tab's "Report a bug" button: a small pill with a bug icon in the window's bottom right, which opens
// orivon://report/ in a tab of its own.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

const dashboards = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().includes('/newtab/') && !w.isClosed())
const reportPages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().startsWith('orivon://report') && !w.isClosed())
const tabCount = async (chrome: Page): Promise<number> => await chrome.locator('.tab').count()

it('shows a small "Report a bug" button with a bug icon at the bottom right, and opens the bug report in a tab of its own', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    expect(await waitFor(() => dashboards(app).length === 1)).toBe(true)
    const dashboard = dashboards(app)[0] as Page
    await dashboard.waitForSelector('html[data-settled="1"]')

    const button = dashboard.locator('#report-bug')
    await button.waitFor({ state: 'visible' })
    expect((await button.textContent())?.trim()).toBe('Report a bug')
    expect(await button.locator('svg').count()).toBe(1)

    // It sits at the bottom of the page, which is the window's corner unless the window is too short for the rows.
    await button.scrollIntoViewIfNeeded()
    const placed = await dashboard.evaluate(() => {
      const box = (document.querySelector('#report-bug') as HTMLElement).getBoundingClientRect()
      const page = document.documentElement
      return { right: page.clientWidth - box.right, bottom: page.scrollHeight - (box.bottom + window.scrollY), width: box.width, height: box.height }
    })
    // At the bottom right corner of the page, and small: a pill, not a banner.
    expect(placed.right).toBeGreaterThanOrEqual(8)
    expect(placed.right).toBeLessThanOrEqual(24)
    expect(placed.bottom).toBeGreaterThanOrEqual(8)
    expect(placed.bottom).toBeLessThanOrEqual(24)
    expect(placed.height).toBeLessThanOrEqual(36)
    expect(placed.width).toBeLessThanOrEqual(160)

    const before = await tabCount(chrome)
    await button.click()
    expect(await waitFor(() => reportPages(app).length === 1)).toBe(true)
    await (reportPages(app)[0] as Page).waitForSelector('#report-what')
    // The report is a tab of its own, as every internal page is, and the dashboard stays in the tab it was in.
    expect(await tabCount(chrome)).toBe(before + 1)
    expect(dashboards(app).length).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
