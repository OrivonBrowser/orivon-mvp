// Visual QA of the real shell: each named state is reached through the UI,
// waited on by its own condition, then audited (layout rules in every shown
// shell view), checked for shell errors and blankness, compared with a
// machine-local pixel baseline, and written to qa-artifacts/latest/states/ for
// a vision-capable reader (npm run qa:report lists them).
//
// Every state is reached once per colour scheme (ORIVON_QA_SCHEMES=light,dark by default; set it to one name to
// run fewer), each with its own baseline, audit and backing check.
//
// Run: npm run qa:visual      First run on a machine records baselines;
//      ORIVON_QA_UPDATE_BASELINES=1 re-records after an intended change.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCommand } from '../support/auth-support.js'
import { clickAddressBarRetrying, runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { captureState, checkState, prepareWindow, type Check, type Rect, type StateSpec } from '../support/qa-visual.js'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, findChrome, findViewShowing, popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

/** The address text of a fixture page: its port changes on every run. */
const FIXTURE_ADDRESS: Rect = { x: 240, y: 44, width: 260, height: 24 }

/** Where a question panel names its origin, whose port changes on every run: the header of a consent question, and the header of a page's own question. */
const CONSENT_ORIGIN_LINE: Rect = { x: 188, y: 78, width: 240, height: 20 }
const PAGE_QUESTION_ORIGIN: Rect = { x: 190, y: 78, width: 240, height: 20 }

/** Settings > Web3's line saying how old the light client's shipped checkpoint is: it reads a day more each day. */
const CHECKPOINT_AGE: Rect = { x: 700, y: 586, width: 440, height: 24 }

const MANIFEST = JSON.stringify({
  orivonApiVersion: 0,
  id: 'app.orivon.fixture.visual-consent',
  name: 'Visual consent fixture',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: { fs: { quotaBytes: 1024 } }
})

/** The schemes every state is captured in. */
const requested = (process.env['ORIVON_QA_SCHEMES'] ?? 'light,dark').split(',').map((s) => s.trim())
const SCHEMES = requested.filter((s): s is 'light' | 'dark' => s === 'light' || s === 'dark')
if (SCHEMES.length === 0 || SCHEMES.length !== requested.length) {
  throw new Error(`ORIVON_QA_SCHEMES must list "light" and/or "dark", comma-separated; got "${process.env['ORIVON_QA_SCHEMES'] ?? ''}"`)
}

type Shell = { orivonShell: { openInternal: (page: string, path?: string) => void } }

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

/** The panel's card sits whole inside its own view: nothing is clipped at an edge and nothing scrolls. */
async function panelFits (panel: Page): Promise<{ fits: boolean, detail: string }> {
  const m = await panel.evaluate(() => {
    const card = (document.querySelector('.q') as HTMLElement).getBoundingClientRect()
    const root = document.documentElement
    const body = document.body.getBoundingClientRect()
    return { left: card.left, top: card.top, right: window.innerWidth - card.right, bottom: window.innerHeight - card.bottom, scrolls: root.scrollHeight > root.clientHeight || root.scrollWidth > root.clientWidth, unpaintedRight: window.innerWidth - body.right, unpaintedBottom: window.innerHeight - body.bottom }
  })
  return { fits: m.left >= 0 && m.top >= 0 && m.right >= 0 && m.bottom >= 0 && !m.scrolls && m.unpaintedRight === 0 && m.unpaintedBottom === 0, detail: JSON.stringify(m) }
}

/** Waits until the popup view whose address contains `part` has kept one size for five polls: a popup is sized after its content reports its height, in more than one step. */
async function popupSized (app: ElectronApplication, part: string): Promise<boolean> {
  let last = ''
  let same = 0
  return await waitFor(async () => {
    const now = await app.evaluate(({ BaseWindow }, needle) => {
      const [win] = BaseWindow.getAllWindows()
      const views = (win?.contentView.children ?? []) as unknown as Array<{ getBounds: () => { x: number, y: number, width: number, height: number }, webContents?: { getURL: () => string } }>
      const view = views.find((v) => (v.webContents?.getURL() ?? '').includes(needle))
      return view === undefined ? '' : JSON.stringify(view.getBounds())
    }, part)
    same = now !== '' && now === last ? same + 1 : 0
    last = now
    await delay(100)
    return same >= 5
  })
}

async function openInternal (app: ElectronApplication, chrome: Page, name: string, path?: string): Promise<Page> {
  await chrome.evaluate(([n, at]) => { (window as unknown as Shell).orivonShell.openInternal(n as string, at) }, [name, path])
  const shown = (): Page | undefined => app.windows().find((w) => w.url().startsWith(`orivon://${name}`))
  expect(await waitFor(() => shown() !== undefined)).toBe(true)
  const page = shown() as Page
  await page.waitForLoadState('load')
  return page
}

const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

it('prepareWindow sets the size the window keeps even when called the moment the shell is up', async () => {
  const { app } = await launchShell()
  try {
    // No wait between launch and the resize: the window may not be shown yet, and showing it re-asserts its initial size.
    await prepareWindow(app, { width: 800, height: 600 })
    const chrome = findChrome(app)
    expect(await waitFor(async () => (await chrome.evaluate(() => window.innerWidth)) === 800)).toBe(true)
    // Absence of a later reset cannot be polled for: settle, then read once.
    await delay(ABSENCE_SETTLE_MS)
    expect(await chrome.evaluate(() => window.innerWidth)).toBe(800)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

for (const scheme of SCHEMES) {
  it(`the shell looks right in each state it can be in (${scheme})`, async () => {
    const { app, chrome } = await launchShell({ scheme })
    try {
      await runPhase('visual states of the shell', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await (dashboardOf(app) as Page).waitForLoadState('load')
        await state(check, app, `dashboard-startup-${scheme}`, {
          expected: 'New-tab dashboard: wallpaper, the Orivon mark and name, a search box, an APPS row with tiles that have icons and labels; one tab titled "New Tab" in the strip; toolbar with back, forward and reload dimmed.',
          action: 'Launched a fresh profile and waited for the dashboard to load.'
        })

        await chrome.click('#address')
        await chrome.fill('#address', 'orivon browser')
        expect(await chrome.inputValue('#address')).toBe('orivon browser')
        expect(await popupSized(app, 'overlay=omnibox')).toBe(true)
        await state(check, app, `address-bar-typed-${scheme}`, {
          expected: 'The address bar is focused and shows the typed text "orivon browser" in full, with no text cut at either edge; the dashboard stays visible underneath.',
          action: 'Clicked the address bar and typed "orivon browser" without pressing Enter.'
        })
        await chrome.fill('#address', '')
        await chrome.press('#address', 'Escape')

        await chrome.click('#menu')
        expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
        const menuPage = app.windows().find((page) => page.url().includes('overlay=menu')) as Page
        check('the menu card fills its view to the right edge', await menuPage.evaluate(() => window.innerWidth - document.body.getBoundingClientRect().right) === 0)
        await state(check, app, `menu-popup-${scheme}`, {
          expected: 'The main menu is open as a popup under the menu button at the top right: a list of labelled entries, none cut off or overlapping, inside the window.',
          action: 'Clicked the menu button and waited for the popup to be shown.'
        })
        await chrome.click('#menu')
        expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)

        await openInternal(app, chrome, 'settings')
        await state(check, app, `settings-page-${scheme}`, {
          expected: 'orivon://settings is open in a new tab: a titled page with a navigation of sections and the selected section shown in full.',
          action: 'Opened orivon://settings from the shell.'
        })
        await openInternal(app, chrome, 'history')
        await state(check, app, `history-page-empty-${scheme}`, {
          expected: 'orivon://history is open with its search box and buttons, and an empty-state message because nothing was visited.',
          action: 'Opened orivon://history on a fresh profile.'
        })
        await openInternal(app, chrome, 'extensions')
        await state(check, app, `extensions-page-empty-${scheme}`, {
          expected: 'orivon://extensions is open, titled, with an empty-state message because no extension is installed.',
          action: 'Opened orivon://extensions on a fresh profile.'
        })

        const view = await visit(app, chrome, `${server.origin}/`)
        await state(check, app, `fixture-page-${scheme}`, {
          expected: 'A plain page titled "Fixture page" shows a heading and one line of text; the address bar shows the 127.0.0.1 address; the tab strip has a tab titled "Fixture page" selected.',
          action: 'Typed the fixture address into the address bar.',
          ignore: [FIXTURE_ADDRESS]
        })
        expect(await view.title()).toBe('Fixture page')

        await chrome.click('#web3-score-btn')
        expect(await waitFor(async () => await popoverShown(app, '/site-info/'))).toBe(true)
        await state(check, app, `site-info-popup-${scheme}`, {
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
        check('a sheet over the tab says the load failed', await waitFor(async () => await popoverShown(app, 'overlay=load-error')))
        expect(await popupSized(app, 'overlay=load-error')).toBe(true)
        await state(check, app, `navigation-failure-${scheme}`, {
          expected: 'A sheet in the middle of the tab area, in this colour scheme: a warning mark, "This site can\'t be reached", the failed address, a sentence saying no server answers to this name, the small name ERR_NAME_NOT_RESOLVED and a filled "Try again" button. The failed address stays in the address bar and its host is the tab title; nothing on the sheet is cut.',
          action: 'Typed http://unresolvable.invalid/ under a resolver that answers nothing but loopback.'
        })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`the welcome screen covers the whole window on a fresh profile (${scheme})`, async () => {
    const { app } = await launchShell({ scheme, env: { ORIVON_INTRO: 'once' } })
    try {
      await runPhase('visual state of the welcome screen', async (check) => {
        expect(await waitFor(() => app.windows().some((w) => w.url().includes('/intro/index.html')))).toBe(true)
        const intro = app.windows().find((w) => w.url().includes('/intro/index.html')) as Page
        await intro.waitForLoadState('load')
        await state(check, app, `welcome-screen-${scheme}`, {
          expected: 'The welcome screen fills the whole window: headline "The browser Web3 deserves.", an "Enter Orivon" button, nothing of the toolbar or dashboard showing through.',
          action: 'Launched a fresh profile with the welcome screen enabled.'
        })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`the dashboard and toolbar still fit in a narrow window (${scheme})`, async () => {
    const { app } = await launchShell({ scheme })
    try {
      await runPhase('visual state of a narrow window', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await (dashboardOf(app) as Page).waitForLoadState('load')
        expect(findChrome(app)).toBeDefined()
        await state(check, app, `dashboard-800x600-${scheme}`, {
          expected: 'At 800x600 the toolbar controls and the address bar all fit on one row with nothing cut or overlapping, the dashboard content stays centred and inside the window.',
          action: 'Resized the window content to 800x600 on the dashboard.'
        }, { width: 800, height: 600 })
        await state(check, app, `dashboard-500x400-${scheme}`, {
          expected: 'At the smallest size a window can have, 500x400, the toolbar is one row: back, forward, reload, the star, an address field wide enough to read an address in, the all-sites button, the side-panel button and the menu. The identity placeholder and the node-status dot are gone, and nothing is cut or overlaps.',
          action: 'Resized the window content to 500x400, the minimum, on the dashboard.'
        }, { width: 500, height: 400 })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`the question panel shows a consent question and a page's confirm() (${scheme})`, async () => {
    // The consent fixture advertises a manifest, so visiting it asks for its grants; the dialog fixture asks nothing until clicked.
    const consent = await startServer((req, res) => {
      if (req.url === '/.well-known/orivon.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(MANIFEST); return }
      html(res, '<!doctype html><meta charset="utf-8"><title>Consent fixture</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body style="font:16px sans-serif;margin:32px"><h1>Consent fixture</h1>')
    })
    const dialogs = await startServer((_req, res) => {
      html(res, '<!doctype html><meta charset="utf-8"><title>Dialog fixture</title><body style="font:16px sans-serif;margin:32px"><h1>Dialog fixture</h1><button id="ask" onclick="window.answer = confirm(\'Delete everything?\')">Ask</button>')
    })
    const { app, chrome } = await launchShell({ scheme })
    try {
      await stubNativeDialogs(app)
      await runPhase('visual states of the question panel', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await prepareWindow(app)

        await clickAddressBarRetrying(chrome, `${consent.origin}/`)
        const grant = await waitQuestion(app)
        await grant.waitForSelector('.q:not(.arming)')
        const said = await readQuestion(grant)
        check('the consent question names the app origin and offers Allow and Deny', said.buttons.includes('Allow') && said.buttons.includes('Deny'), JSON.stringify(said))
        const shown = [said.origin, said.title, said.message, said.detail].join('\n')
        check('the consent question names the origin once', said.origin.length > 0 && shown.split(said.origin).length === 2, JSON.stringify(said))
        const grantFit = await panelFits(grant)
        check('the consent card sits inside its view, uncut and unscrolled', grantFit.fits, grantFit.detail)
        await state(check, app, `question-consent-${scheme}`, {
          expected: 'A question panel floats over the page, directly under the address pill with its top edge crossing into the toolbar: a header naming the 127.0.0.1 origin that is asking, a message about what the app wants, and two readable buttons, Allow and Deny, with Allow the filled one. Text and buttons are fully inside the panel in this colour scheme, nothing is cut, and the page and toolbar stay visible around it.',
          action: 'Typed the address of a loopback app that advertises a manifest and waited for its grant question to arm.',
          ignore: [FIXTURE_ADDRESS, CONSENT_ORIGIN_LINE]
        })
        await answerQuestion(app, 'Deny')

        await visit(app, chrome, `${dialogs.origin}/`)
        const view = findViewShowing(app, chrome, `${dialogs.origin}/`) as Page
        view.on('dialog', () => {}) // The debugger reports each dialog; Playwright must not answer it.
        // The click does not return until the question is answered, which is after the state is read: it gets the time that takes.
        const asking = view.click('#ask', { timeout: 60_000 })
        const confirmPanel = await waitQuestion(app)
        await confirmPanel.waitForSelector('.q:not(.arming)')
        const confirmSaid = await readQuestion(confirmPanel)
        check('the confirm() panel is headed with the page origin and offers OK and Cancel', confirmSaid.origin === `${dialogs.origin} says` && confirmSaid.message === 'Delete everything?' && confirmSaid.buttons.includes('OK') && confirmSaid.buttons.includes('Cancel'), JSON.stringify(confirmSaid))
        const confirmFit = await panelFits(confirmPanel)
        check('the confirm card sits inside its view, uncut and unscrolled', confirmFit.fits, confirmFit.detail)
        await state(check, app, `question-page-confirm-${scheme}`, {
          expected: 'A question panel floats over the page, directly under the address pill with its top edge crossing into the toolbar: a header reading "<127.0.0.1 origin> says", the message "Delete everything?" and two readable buttons, Cancel and OK, with OK the filled one. A dashed line down the left edge of the panel marks a question that comes from the page. Text and buttons are fully inside the panel in this colour scheme, nothing is cut. The page behind may show as flat grey in the picture, because its script is paused inside confirm() and cannot be captured.',
          action: 'Clicked a button on a loopback page whose script calls confirm("Delete everything?").',
          ignore: [FIXTURE_ADDRESS, PAGE_QUESTION_ORIGIN]
        })
        await answerQuestion(app, 'Cancel')
        await asking
        check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
      })
    } finally {
      await closeElectron(app)
      await consent.close()
      await dialogs.close()
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`the shell parts fixed in this round look right: bookmarks overflow, Web3 and Profiles settings, a crowded tab strip (${scheme})`, async () => {
    const bookmarks = JSON.stringify({
      version: 2,
      roots: {
        bar: Array.from({ length: 30 }, (_, i) => ({ id: `bar${String(i)}`, kind: 'url', title: `Bookmark number ${String(i + 1)}`, url: `${server.origin}/b${String(i)}`, added: 1 })),
        other: [],
        reading: []
      }
    })
    const { app, chrome } = await launchShell({ scheme, seedProfile: async (dir) => { await writeFile(join(dir, 'bookmarks.json'), bookmarks) } })
    try {
      await runPhase('visual states of what this round fixed', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await (dashboardOf(app) as Page).waitForLoadState('load')
        expect(await waitFor(async () => (await evaluateRetrying(chrome, () => document.querySelectorAll('#bookmarks-list .bmitem').length)) > 3)).toBe(true)

        await prepareWindow(app, { width: 700, height: 600 })
        await chrome.evaluate(async () => { await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) }) })
        const bar = await chrome.evaluate(() => {
          const list = document.querySelector('#bookmarks-list') as HTMLElement
          const edge = list.getBoundingClientRect().right
          const shown = Array.from(list.querySelectorAll<HTMLElement>('.bmitem, .bmmore')).filter((el) => !el.hidden)
          return { chevrons: list.querySelectorAll('.bmmore:not([hidden])').length, items: shown.filter((el) => el.classList.contains('bmitem')).length, overhang: Math.max(...shown.map((el) => el.getBoundingClientRect().right - edge)) }
        })
        check('the bookmarks bar at 700 px shows some bookmarks and one chevron, and nothing passes the bar\'s right edge', bar.chevrons === 1 && bar.items > 1 && bar.items < 30 && bar.overhang <= 0, JSON.stringify(bar))
        await state(check, app, `bookmarks-bar-overflow-${scheme}`, {
          expected: 'At 700 px wide a row of bookmarks sits under the address bar: whole bookmark buttons from the left, then a chevron at the right end of the row that stands for the rest. No bookmark is cut by the right edge or the chevron, and nothing overlaps the toolbar.',
          action: 'Launched a profile with 30 bookmarks on the bar and resized the window content to 700x600.'
        }, { width: 700, height: 600 })

        const web3 = await openInternal(app, chrome, 'settings', '/web3')
        await web3.waitForSelector('#row-web3-forced-off')
        const toggle = web3.locator('#row-web3-light-client input[type=checkbox]')
        const stateLine = (await web3.locator('#row-web3-state .value').textContent()) ?? ''
        check('Settings > Web3: the light-client switch is off and disabled while this run forces it off, and its state line is a sentence', await toggle.isDisabled() && !(await toggle.isChecked()) && /^[A-Z]/.test(stateLine) && !/^[a-z]+: /.test(stateLine), stateLine)
        check('the key and the Web2 pill stay away from a Settings page', !(await chrome.locator('#site-permissions-btn').isVisible()) && !(await chrome.locator('#web3-mark').isVisible()))
        await state(check, app, `settings-web3-${scheme}`, {
          expected: 'orivon://settings/web3 is open with Web3 selected in the navigation. A light-client row shows its switch OFF and greyed out, labelled "Off for this run" because this run forces it off; the state row below it is a full sentence beginning with a capital letter, not a "code: value" pair. No key button sits in the address field.',
          action: 'Opened orivon://settings/web3 in a run that forces the light client off.',
          ignore: [CHECKPOINT_AGE]
        })

        const profiles = await openInternal(app, chrome, 'profiles')
        await profiles.waitForSelector('.create .btn')
        const heights = await profiles.evaluate(() => ['.top .btn', '.create .btn', '.create .text'].map((sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().height))
        check('Profiles: the Create profile button is on one line, as tall as its text field', heights[1] === heights[0] && heights[2] === heights[0], JSON.stringify(heights))
        await state(check, app, `profiles-page-${scheme}`, {
          expected: 'orivon://profiles is open: one profile card marked "This window", and a create row with a text field, colour swatches and a "Create profile" button whose label is on a single line, the button as tall as the field next to it.',
          action: 'Opened orivon://profiles on a fresh profile.'
        })

        await prepareWindow(app, { width: 700, height: 600 })
        for (let i = 0; i < 24; i += 1) await runCommand(chrome, 'tab.new')
        expect(await waitFor(async () => (await evaluateRetrying(chrome, () => document.querySelectorAll('#tab-scroll .tab').length)) >= 27)).toBe(true)
        // The 25 dashboards share one address, so the capture could not tell which view is the front one: the front tab goes to the fixture page, which has an address of its own.
        await visit(app, chrome, `${server.origin}/`)
        await chrome.evaluate(async () => { await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) }) })
        const strip = await chrome.evaluate(() => {
          const scroller = document.querySelector('#tab-scroll') as HTMLElement
          const view = scroller.getBoundingClientRect()
          const active = scroller.querySelector('.tab.active') as HTMLElement
          const a = active.getBoundingClientRect()
          const narrowInactive = Array.from(scroller.querySelectorAll<HTMLElement>('.tab:not(.active)')).filter((t) => t.getBoundingClientRect().width <= 63)
          return {
            activeInView: a.left >= view.left - 0.5 && a.right <= view.right + 0.5,
            narrowInactive: narrowInactive.length,
            narrowWithClose: narrowInactive.filter((t) => { const c = t.querySelector('.close'); return c !== null && getComputedStyle(c).display !== 'none' }).length,
            tabs: scroller.querySelectorAll('.tab').length
          }
        })
        check('the tab strip with 27 tabs keeps the active tab in view and gives no narrow inactive tab a close button', strip.activeInView && strip.narrowInactive > 0 && strip.narrowWithClose === 0, JSON.stringify(strip))
        await state(check, app, `tab-strip-crowded-${scheme}`, {
          expected: 'At 700 px with 27 tabs the strip holds tabs squeezed to icons; the tab in front (the last one, the Fixture page) is fully inside the strip, drawn as the selected tab with its icon (its close button shows only while the pointer is over it); the other narrow tabs show only their icon, with no close button on them. The new-tab button and the strip\'s overflow control stay visible; the fixture page (heading and one line of text) fills the page area under the toolbar and bookmarks bar.',
          action: 'Opened 24 more tabs with the new-tab command in a 700x600 window, then loaded the fixture page in the front one.',
          ignore: [{ x: 240, y: 44, width: 200, height: 24 }]
        }, { width: 700, height: 600 })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS * 2)
}
