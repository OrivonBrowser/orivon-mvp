// Visual QA of the real shell: each named state is reached through the UI,
// waited on by its own condition, then audited (layout rules in every shown
// shell view), checked for shell errors and blankness, compared with a
// machine-local pixel baseline, and written to qa-artifacts/latest/states/ for
// a vision-capable reader (npm run qa:report lists them).
//
// Run: npm run qa:visual      First run on a machine records baselines;
//      ORIVON_QA_UPDATE_BASELINES=1 re-records after an intended change.

import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runPhase } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './qa-helpers.js'
import { captureState, checkState, prepareWindow, type Check, type Rect, type StateSpec } from './qa-visual.js'
import { findChrome, popoverShown, waitFor, waitForTab } from './smoke-helpers.mjs'

/** The address text of a fixture page: its port changes on every run. */
const FIXTURE_ADDRESS: Rect = { x: 240, y: 44, width: 260, height: 24 }

type Shell = { orivonShell: { openInternal: (page: string) => void } }

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((_req, res) => {
    html(res, '<!doctype html><meta charset="utf-8"><title>Fixture page</title><body style="font:16px sans-serif;margin:32px"><h1>Fixture page</h1><p>Plain content served from 127.0.0.1.</p>')
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function state (check: Check, app: ElectronApplication, name: string, spec: StateSpec, size?: { width: number, height: number }): Promise<void> {
  await prepareWindow(app, size)
  checkState(check, await captureState(app, name, spec))
}

async function openInternal (app: ElectronApplication, chrome: Page, name: string): Promise<Page> {
  await chrome.evaluate((n) => { (window as unknown as Shell).orivonShell.openInternal(n) }, name)
  const shown = (): Page | undefined => app.windows().find((w) => w.url().startsWith(`orivon://${name}`))
  expect(await waitFor(() => shown() !== undefined)).toBe(true)
  const page = shown() as Page
  await page.waitForLoadState('load')
  return page
}

const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

it('the shell looks right in each state it can be in', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('visual states of the shell', async (check) => {
      expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
      await (dashboardOf(app) as Page).waitForLoadState('load')
      await state(check, app, 'dashboard-startup', {
        expected: 'New-tab dashboard: wallpaper, the Orivon mark and name, a search box, an APPS row with tiles that have icons and labels; one tab titled "New Tab" in the strip; toolbar with back, forward and reload dimmed.',
        action: 'Launched a fresh profile and waited for the dashboard to load.'
      })

      await chrome.click('#address')
      await chrome.fill('#address', 'orivon browser')
      expect(await chrome.inputValue('#address')).toBe('orivon browser')
      await state(check, app, 'address-bar-typed', {
        expected: 'The address bar is focused and shows the typed text "orivon browser" in full, with no text cut at either edge; the dashboard stays visible underneath.',
        action: 'Clicked the address bar and typed "orivon browser" without pressing Enter.'
      })
      await chrome.fill('#address', '')
      await chrome.press('#address', 'Escape')

      await chrome.click('#menu')
      expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
      await state(check, app, 'menu-popup', {
        expected: 'The main menu is open as a popup under the menu button at the top right: a list of labelled entries, none cut off or overlapping, inside the window.',
        action: 'Clicked the menu button and waited for the popup to be shown.'
      })
      await chrome.click('#menu')
      expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)

      await openInternal(app, chrome, 'settings')
      await state(check, app, 'settings-page', {
        expected: 'orivon://settings is open in a new tab: a titled page with a navigation of sections and the selected section shown in full.',
        action: 'Opened orivon://settings from the shell.'
      })
      await openInternal(app, chrome, 'history')
      await state(check, app, 'history-page-empty', {
        expected: 'orivon://history is open with its search box and buttons, and an empty-state message because nothing was visited.',
        action: 'Opened orivon://history on a fresh profile.'
      })
      await openInternal(app, chrome, 'extensions')
      await state(check, app, 'extensions-page-empty', {
        expected: 'orivon://extensions is open, titled, with an empty-state message because no extension is installed.',
        action: 'Opened orivon://extensions on a fresh profile.'
      })

      const view = await visit(app, chrome, `${server.origin}/`)
      await state(check, app, 'fixture-page', {
        expected: 'A plain page titled "Fixture page" shows a heading and one line of text; the address bar shows the 127.0.0.1 address; the tab strip has a tab titled "Fixture page" selected.',
        action: 'Typed the fixture address into the address bar.',
        ignore: [FIXTURE_ADDRESS]
      })
      expect(await view.title()).toBe('Fixture page')

      await chrome.click('#web3-score-btn')
      expect(await waitFor(async () => await popoverShown(app, '/site-info/'))).toBe(true)
      await state(check, app, 'site-info-popup', {
        expected: 'The popup under the shield button is headed "Web3 Score" with a back arrow, lists levels L1 to L4 with L1 marked for this plain website, and explains why; it overlays the page, sits inside the window and scrolls inside itself.',
        action: 'Clicked the shield button on the fixture page.',
        ignore: [FIXTURE_ADDRESS]
      })
      await chrome.click('#web3-score-btn')

      await chrome.click('#address')
      await chrome.fill('#address', 'http://unresolvable.invalid/')
      await chrome.press('#address', 'Enter')
      expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('chrome-error://')))).toBe(true)
      // The shell pushes the address and the nav buttons on later events than the error view appearing: wait on each.
      const failed = await waitForTab(chrome, { address: 'http://unresolvable.invalid/' })
      check('the address bar keeps the address that failed', failed.ok, `address bar shows ${await chrome.inputValue('#address')}`)
      check('back is enabled, so the person can leave the failed page', await waitFor(async () => await chrome.isEnabled('#back')))
      await state(check, app, 'navigation-failure', {
        expected: 'Today a blank white view under the tab strip, with the failed address in the address bar and its host as the tab title: the shell draws no failure message (docs/open-questions.md, a failed navigation). A message or error page here means that was fixed: update this expectation and re-record the baseline.',
        action: 'Typed http://unresolvable.invalid/ under a resolver that answers nothing but loopback.'
      })
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('the welcome screen covers the whole window on a fresh profile', async () => {
  const { app } = await launchShell({ env: { ORIVON_INTRO: 'once' } })
  try {
    await runPhase('visual state of the welcome screen', async (check) => {
      expect(await waitFor(() => app.windows().some((w) => w.url().includes('/intro/index.html')))).toBe(true)
      const intro = app.windows().find((w) => w.url().includes('/intro/index.html')) as Page
      await intro.waitForLoadState('load')
      await state(check, app, 'welcome-screen', {
        expected: 'The welcome screen fills the whole window: headline "The browser Web3 deserves.", an "Enter Orivon" button, nothing of the toolbar or dashboard showing through.',
        action: 'Launched a fresh profile with the welcome screen enabled.'
      })
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('the dashboard and toolbar still fit in a narrow window', async () => {
  const { app } = await launchShell()
  try {
    await runPhase('visual state of a narrow window', async (check) => {
      expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
      await (dashboardOf(app) as Page).waitForLoadState('load')
      expect(findChrome(app)).toBeDefined()
      await state(check, app, 'dashboard-800x600', {
        expected: 'At 800x600 the toolbar controls and the address bar all fit on one row with nothing cut or overlapping, the dashboard content stays centred and inside the window.',
        action: 'Resized the window content to 800x600 on the dashboard.'
      }, { width: 800, height: 600 })
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
