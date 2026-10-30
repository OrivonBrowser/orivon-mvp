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

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runCommand } from '../support/auth-support.js'
import { focusWebContents, underVirtualDisplay } from '../support/focus-helpers.js'
import { clickAddressBarRetrying, runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from '../support/qa-helpers.js'
import { captureState, checkState, prepareWindow, type Check, type Rect, type StateSpec } from '../support/qa-visual.js'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, findChrome, findViewShowing, popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { fuseFilePath, readFileProtocolFuse } from '../../src/main/local-files/file-fuse.js'

/** The address text of a fixture page: its port changes on every run. */
const FIXTURE_ADDRESS: Rect = { x: 240, y: 44, width: 260, height: 24 }

/** Where a question panel names its origin, whose port changes on every run: the header of a consent question, and the header of a page's own question. */
const CONSENT_ORIGIN_LINE: Rect = { x: 188, y: 78, width: 240, height: 20 }
const PAGE_QUESTION_ORIGIN: Rect = { x: 190, y: 78, width: 240, height: 20 }

/** The site popup's header, which names the fixture's origin and so its port. */
const SITE_INFO_ORIGIN_LINE: Rect = { x: 224, y: 86, width: 220, height: 22 }

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

/** The consent fixture's manifest also names where its publisher takes problem reports, so the site panel shows that row. */
const CONSENT_MANIFEST = JSON.stringify({ ...JSON.parse(MANIFEST) as object, support: { issues: 'https://support.example.test/issues/new' } })

/** Windows lets no program make itself the default browser, so the row there opens Windows' own settings. */
const MAKE_DEFAULT = process.platform === 'win32' ? 'Open Windows Settings' : 'Make default'

// Local files serve nothing while the binary's file-protocol fuse is on, as it stays in a checkout whose install
// could not flip it. e2e-file-protocol-fuse fails when it is on, so skipping here hides nothing.
const electronPath: string = createRequire(import.meta.url)('electron')
const localFilesServed = await readFileProtocolFuse(fuseFilePath(electronPath)) === 'off'

/** The schemes every state is captured in. */
const requested = (process.env['ORIVON_QA_SCHEMES'] ?? 'light,dark').split(',').map((s) => s.trim())
const SCHEMES = requested.filter((s): s is 'light' | 'dark' => s === 'light' || s === 'dark')
if (SCHEMES.length === 0 || SCHEMES.length !== requested.length) {
  throw new Error(`ORIVON_QA_SCHEMES must list "light" and/or "dark", comma-separated; got "${process.env['ORIVON_QA_SCHEMES'] ?? ''}"`)
}

type Shell = { orivonShell: { openInternal: (page: string, path?: string) => void } }

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/links') {
      html(res, '<!doctype html><meta charset="utf-8"><title>Links page</title><body style="font:16px sans-serif;margin:32px"><h1>Links page</h1><p><a id="next" href="/next-page">A link to the next page</a></p>')
      return
    }
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

/** The Settings page draws all its rows again whenever one of its parts reports (the tunnel, the profiles, the sites), and a redraw drops the scroll and detaches the row. So the row is scrolled to once the page has been quiet for half a second, from the page itself, which holds no element across a redraw. */
async function scrollToTunnelRow (settings: Page): Promise<void> {
  await settings.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let timer = setTimeout(done, 500)
      const watching = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 500) })
      function done (): void { watching.disconnect(); resolve() }
      watching.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    ;(document.getElementById('row-route-kind') as (HTMLElement & { scrollIntoViewIfNeeded?: () => void }) | null)?.scrollIntoViewIfNeeded?.()
  })
}

for (const scheme of SCHEMES) {
  it(`the shell looks right in each state it can be in (${scheme})`, async () => {
    const { app, chrome } = await launchShell({ scheme })
    try {
      await runPhase('visual states of the shell', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await (dashboardOf(app) as Page).waitForLoadState('load')
        await (dashboardOf(app) as Page).waitForSelector('html[data-settled="1"]')
        await state(check, app, `dashboard-startup-${scheme}`, {
          expected: 'New-tab dashboard: wallpaper, the Orivon mark and name, a search box, then an "Orivon Featured" row of five tiles (Explore, WebTorrent, ASGARDEX, Ledger Wallet, The Lounge) that have icons and labels, with no other block under it; a small pill button with a bug icon and the text "Report a bug" in the bottom right corner of the page, over no tile, which in a window too short for the rows comes after the last row; in a window too short for the rows, the lower part is cut at the window edge and scrolls; one tab titled "New Tab" in the strip; toolbar with back, forward and reload dimmed.',
          action: 'Launched a fresh profile and waited for the dashboard to load and draw its rows.'
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
        // The menu counts as shown once its view is attached, and this click follows the hover that builds the view by moments, so its page can still be loading: until its stylesheet applies, a layout read sees the browser's own 8px body margin.
        await menuPage.waitForLoadState('load')
        await menuPage.waitForSelector('.menu-row')
        check('the menu card fills its view to the right edge', await menuPage.evaluate(() => document.documentElement.clientWidth - document.body.getBoundingClientRect().right) === 0)
        await state(check, app, `menu-popup-${scheme}`, {
          expected: 'The main menu is open as a popup under the menu button at the top right: a list of labelled entries, none cut off or overlapping, inside the window.',
          action: 'Clicked the menu button and waited for the popup to be shown.'
        })
        await chrome.click('#menu')
        expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)

        await chrome.click('#web3-score-btn')
        expect(await popupSized(app, 'overlay=web3-score')).toBe(true)
        await state(check, app, `web3-score-card-${scheme}`, {
          expected: 'A card under the shield at the left of the address bar, headed "Web3 Score" beside a grey shield: one sentence on what the shield shows, then four rows, Level 1 to Level 4, each with a shield in its colour (red, orange, yellow, green), a Web2, Web2.5, Web2.5 or Web3 mark and one line of meaning; a note led by a gray "Web?" mark on a Level 2 site no provider has scored yet; a note on which levels this computer checks, and two links, "Choose a score provider" and "How scores work". Nothing is cut and the card sits inside the window.',
          action: 'Clicked the shield button on the new tab.'
        })
        await chrome.click('#web3-score-btn')
        expect(await waitFor(async () => !(await popoverShown(app, 'overlay=web3-score')))).toBe(true)

        await delay(450)
        check('the tunnel button is on the new tab and plain, as no tunnel is chosen for the tab', await chrome.locator('#tunnel-btn').isVisible() && await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null && await chrome.getAttribute('#tunnel-btn', 'aria-label') === 'Tunnels')
        await chrome.click('#tunnel-btn')
        expect(await waitFor(async () => await popoverShown(app, '/site-info/'))).toBe(true)
        const tabList = app.windows().find((w) => w.url().includes('/site-info/')) as Page
        await tabList.waitForSelector('#tunnel-switch-nym')
        expect(await popupSized(app, '/site-info/')).toBe(true)
        await state(check, app, `tunnel-list-new-tab-${scheme}`, {
          expected: 'The popup under the tunnel button on the new tab, headed "Tunnels" with "This tab" under it, lists two tunnels, "Nym" with its logo and "Your proxy" with the generic tunnel icon, each with a switch that is off, and one sentence under them that says to pick a tunnel and every site opened in this tab goes through it; nothing is cut off, and the popup sits inside the window. The tunnel button at the right end of the address pill is open (pressed) and plain.',
          action: 'Clicked the tunnel button on the new tab and waited for its list to be drawn.'
        })
        await chrome.click('#tunnel-btn')
        expect(await waitFor(async () => !(await popoverShown(app, '/site-info/')))).toBe(true)

        const settingsPage = await openInternal(app, chrome, 'settings')
        await state(check, app, `settings-page-${scheme}`, {
          expected: 'orivon://settings is open in a new tab: a titled page with a navigation of sections and the selected section shown in full.',
          action: 'Opened orivon://settings from the shell.'
        })
        await settingsPage.waitForSelector('#row-new-tab-background select')
        await settingsPage.locator('#row-new-tab-background').scrollIntoViewIfNeeded()
        await state(check, app, `settings-appearance-${scheme}`, {
          expected: 'The Appearance section of orivon://settings, the first one, scrolled to show, under a "New tab" heading, a row "New tab background" with a drop-down that reads "The Orivon picture", and no "Your picture" row, since no picture of the person\'s own is in use. Nothing is cut or overlapping.',
          action: 'Scrolled the Appearance section to the New tab background row.'
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
        expect(await waitFor(async () => !(await popoverShown(app, '/site-info/')))).toBe(true)

        await delay(450) // past the debounce that reads a toggle just after a close as that close's echo
        await chrome.click('#web3-mark')
        expect(await popupSized(app, 'overlay=web3-score')).toBe(true)
        await state(check, app, `web3-mark-card-${scheme}`, {
          expected: 'The Web3 Score card is open under the Web2 mark at the right end of the address bar, inside the window: the same four level rows as from the shield, with the Level 1 row outlined in red and tagged "This site" at its right end, and no other row outlined or tagged. The gray "Web?" note at the foot is plain.',
          action: 'Clicked the Web2 mark in the address bar on the fixture page.',
          ignore: [FIXTURE_ADDRESS]
        })
        await chrome.click('#web3-mark')
        expect(await waitFor(async () => !(await popoverShown(app, 'overlay=web3-score')))).toBe(true)

        await delay(450)
        await chrome.click('#networks-btn')
        expect(await waitFor(async () => await popoverShown(app, '/networks/'))).toBe(true)
        expect(await popupSized(app, '/networks/')).toBe(true)
        await state(check, app, `networks-popup-${scheme}`, {
          expected: 'The popup under the Available networks button, the network icon at the top right, is headed "Available networks" with one plain line under it, and lists four cards in order: Ethereum light client, IPFS node, Swarm node and Nym tunnel. Each has a status word, a switch at the right (the light client\'s off and dimmed in a test run), one sentence and, where a node runs, figures; none is cut off or overlaps, and the popup sits inside the window.',
          action: 'Closed the shield popup and clicked the Available networks button on the fixture page.',
          ignore: [FIXTURE_ADDRESS]
        })
        await chrome.click('#networks-btn')
        expect(await waitFor(async () => !(await popoverShown(app, '/networks/')))).toBe(true)

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
    const { app } = await launchShell({ scheme, env: { ORIVON_INTRO: 'once' }, chrome: false })
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

  it(`Settings > Default browser looks right (${scheme})`, async () => {
    const { app, chrome } = await launchShell({ scheme, env: { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' } })
    try {
      await runPhase('visual state of Settings > Default browser', async (check) => {
        const settings = await openInternal(app, chrome, 'settings', '/default-browser')
        await settings.waitForSelector('#row-default-browser button')
        check(`Settings > Default browser has the section in the navigation and a ${MAKE_DEFAULT} button`, (await settings.locator('.nav-list').innerText()).includes('Default browser') && await settings.getByRole('button', { name: MAKE_DEFAULT }).isVisible())
        await state(check, app, `settings-default-browser-${scheme}`, {
          expected: `orivon://settings/default-browser is open with "Default browser" selected in the navigation, directly under Search. The section has a short intro line and one row labelled "Default browser" with the help text "Links you click in other programs open in Orivon." and a "${MAKE_DEFAULT}" button on its right.`,
          action: 'Opened orivon://settings/default-browser on a build that can register as the default browser.'
        })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`Settings > Tunnels looks right on Nym and on an address (${scheme})`, async () => {
    const { app, chrome } = await launchShell({ scheme, seedProfile: async (dir) => { writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 2, values: {} })) } })
    try {
      await runPhase('visual states of Settings > Tunnels', async (check) => {
        const settings = await openInternal(app, chrome, 'settings', '/tunnels')
        await settings.waitForSelector('#row-route-nym-status:has-text("Starts when")')
        await scrollToTunnelRow(settings)
        check('the default tunnel is Nym (built in); the Nym rows, the address row and a Test for each tunnel are all shown', (await settings.locator('#row-route-kind select').inputValue()) === 'nym' && await settings.locator('#row-route-nym-status').isVisible() && await settings.locator('#row-route-nym-privacy select').inputValue() === 'balanced' && await settings.locator('#row-route-proxy').isVisible() && await settings.locator('#row-route-nym-test button').isVisible() && await settings.locator('#row-route-proxy-test button').isVisible())
        await state(check, app, `settings-tunnel-nym-${scheme}`, {
          expected: 'orivon://settings/tunnels is open under the heading "Tunnels" with the "Default tunnel" row showing the choice "Nym (built in)" and the "Send all of Orivon\'s traffic through the default tunnel" row, then a "Nym" group with a "Let Nym run" switch, a "Nym" row saying "Starts when an app that uses it connects.", a "Nym privacy" row with a choice showing "Balanced" and one sentence for each of Balanced and Strongest, and a "Test Nym" row with a Test button; then a "Your proxy" group with a "SOCKS5 address" row holding an empty text field whose placeholder is 127.0.0.1:9050 and a "Test your proxy" row whose Test button is greyed out.',
          action: 'Opened orivon://settings/tunnels on a fresh profile and scrolled to the tunnel rows.'
        })
        await settings.locator('#row-route-kind select').selectOption('socks5')
        await settings.waitForFunction(() => (document.querySelector('#row-route-kind select') as HTMLSelectElement | null)?.value === 'socks5')
        await scrollToTunnelRow(settings)
        check('choosing the address as the default hides nothing: Nym\'s rows and the address row are all still shown', await settings.locator('#row-route-proxy input').isVisible() && await settings.locator('#row-route-nym-status').isVisible() && await settings.locator('#row-route-nym-privacy').isVisible())
        await state(check, app, `settings-tunnel-address-${scheme}`, {
          expected: 'The "Default tunnel" row shows "Your own SOCKS5 address"; every other row is still there, Nym\'s and the proxy\'s, because a site or app can use either whichever is the default; the "Test your proxy" Test button is greyed out while the address is empty.',
          action: 'Chose "Your own SOCKS5 address" in the default tunnel row.'
        })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`the telemetry popup "Enter Orivon" opens looks right, closed and with what is sent open (${scheme})`, async () => {
    const { app } = await launchShell({ scheme, env: { ORIVON_INTRO: 'once', ORIVON_TELEMETRY: 'on' }, chrome: false })
    try {
      await runPhase('visual states of the telemetry popup', async (check) => {
        expect(await waitFor(() => app.windows().some((w) => w.url().includes('/intro/index.html')))).toBe(true)
        const intro = app.windows().find((w) => w.url().includes('/intro/index.html')) as Page
        await intro.waitForLoadState('load')
        await intro.click('#enter')
        await intro.waitForSelector('#consent:not([hidden])')
        // The card rises in, the welcome scene softens out of focus and the browser's picture fades in over it: wait until all three have finished.
        expect(await waitFor(async () => Number(await intro.locator('.consent-card').evaluate((el) => getComputedStyle(el).opacity)) === 1 && await intro.locator('#welcome').evaluate((el) => getComputedStyle(el).filter) === 'blur(18px)' && Number(await intro.locator('#welcome').evaluate((el) => getComputedStyle(el).opacity)) === 0.4)).toBe(true)
        expect(await waitFor(async () => Number(await intro.locator('#behind').evaluate((el) => getComputedStyle(el).opacity)) === 1, 10_000)).toBe(true)
        // What shows blurred behind is the new tab. The popup's picture of it is taken once the page says every row is drawn (`data-settled`), so wait for that and for the rows it names.
        expect(await waitFor(async () => { const page = dashboardOf(app); return page !== undefined && await page.locator('html[data-settled="1"]').count() === 1 && await page.locator('#featured-grid .tile').count() > 0 })).toBe(true)
        check('neither of the two buttons has the focus', await intro.evaluate(() => document.activeElement?.tagName) === 'BODY')
        await state(check, app, `welcome-telemetry-popup-${scheme}`, {
          expected: 'Behind, the browser (its toolbar and the new-tab page) blurred past reading and dimmed, filling the whole window. In the middle, a rounded dark-indigo card: the round Orivon logo with a soft glow, the title "Support us for free through telemetry", a short paragraph that starts "Orivon is free, has no ads, and keeps your history on your computer", a panel of four short promises in two columns each with a small green check, a "See exactly what is sent" link with a chevron, and two pill buttons of the same size and look side by side, "Accept" and "Deny", neither filled more than the other. All text is readable and the card stays inside the window.',
          action: 'Launched a fresh profile with the welcome screen enabled and telemetry running, and clicked "Enter Orivon".'
        })
        await intro.click('.consent-details summary')
        await intro.waitForSelector('.consent-details[open]')
        await state(check, app, `welcome-telemetry-details-${scheme}`, {
          expected: 'The same popup with "See exactly what is sent" open: the chevron points up and a darker rounded panel of four short bullets sits under the link, inside the card; the card grew downwards with the buttons still under it, and if it no longer fits the window it scrolls rather than being cut.',
          action: 'Opened "See exactly what is sent" on the telemetry popup.'
        })
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it.skipIf(!underVirtualDisplay())(`the weekly default-browser ask is drawn like every other question (${scheme})`, async () => {
    const day = 86_400_000
    const { app, chrome } = await launchShell({
      scheme,
      env: { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' },
      seedProfile: (dir: string) => { writeFileSync(join(dir, 'default-browser-ask.json'), JSON.stringify({ firstSeenAt: Date.now() - 20 * day, lastAskedAt: Date.now() - 9 * day, stopped: false })) }
    })
    try {
      await runPhase('visual state of the default-browser ask', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await stubNativeDialogs(app)
        await prepareWindow(app)
        await visit(app, chrome, `${server.origin}/`)
        await focusWebContents(app, `${server.origin}/`)
        await app.evaluate(() => { void (globalThis as unknown as { __orivonDevDefaultBrowserAskNow?: () => Promise<void> }).__orivonDevDefaultBrowserAskNow?.() })
        const panel = await waitQuestion(app)
        await panel.waitForSelector('.q:not(.arming)')
        const said = await readQuestion(panel)
        check('the ask has three buttons, the way out first', said.buttons.join('|') === 'Not now|Make default|Don\'t ask again', JSON.stringify(said))
        const fit = await panelFits(panel)
        check('the ask card sits inside its view, uncut and unscrolled', fit.fits, fit.detail)
        await state(check, app, `default-browser-ask-${scheme}`, {
          expected: 'A question panel floats over the page, directly under the address pill: the title "Make Orivon your default browser?", the message "Links you click in other programs will open in Orivon.", and three readable buttons in a row, Not now, Make default (the filled one) and Don\'t ask again. Text and buttons are fully inside the panel, nothing is cut, and the page and toolbar stay visible around it.',
          action: 'Seeded a profile first seen 20 days ago and last asked 9 days ago, focused a fixture page and ran the weekly check.',
          ignore: [FIXTURE_ADDRESS]
        })
        await answerQuestion(app, 'Not now')
        check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it.skipIf(!underVirtualDisplay())(`the update question offers both downloads and a way out inside its panel (${scheme})`, async () => {
    const { app, chrome } = await launchShell({ scheme, env: { ORIVON_TEST_UPDATE_RELEASE: 'v99.0.0' } })
    try {
      await runPhase('visual state of the update question', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await stubNativeDialogs(app)
        await prepareWindow(app)
        await visit(app, chrome, `${server.origin}/`)
        await focusWebContents(app, `${server.origin}/`)
        await app.evaluate(() => { void (globalThis as unknown as { __orivonDevUpdateCheckNow?: () => Promise<void> }).__orivonDevUpdateCheckNow?.() })
        const panel = await waitQuestion(app)
        await panel.waitForSelector('.q:not(.arming)')
        const said = await readQuestion(panel)
        check('the question names the release and lists the way out first, then both downloads', said.title === 'Orivon 99.0.0 is available' && said.buttons.join('|') === 'Not now|Download from GitHub|Download from latest.orivonstack.eth', JSON.stringify(said))
        const fit = await panelFits(panel)
        check('the question card sits inside its view, uncut and unscrolled', fit.fits, fit.detail)
        await state(check, app, `update-question-${scheme}`, {
          expected: 'A question panel floats over the page, directly under the address pill: the title "Orivon 99.0.0 is available", the message "You have" followed by the running version, and three buttons, Not now as plain text on the left, then Download from GitHub (the filled one) and Download from latest.orivonstack.eth, wrapping onto a second row if they do not fit in one. Every label is whole and readable, nothing is cut, and the page and toolbar stay visible around it.',
          action: 'Pointed the update check at a release newer than the running one, focused a fixture page and ran the check.',
          ignore: [FIXTURE_ADDRESS]
        })
        await answerQuestion(app, 'Not now')
        check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
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
          expected: 'At the smallest size a window can have, 500x400, the toolbar is one row: back, forward, reload, the star, an address field wide enough to read an address in, the Available networks button, the Extensions button, the side-panel button and the menu. The separator in the cluster is gone, and nothing is cut or overlaps.',
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
      if (req.url === '/.well-known/orivon.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(CONSENT_MANIFEST); return }
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
        check('the consent question names the app origin and offers Grant all and Close', said.buttons.includes('Grant all') && said.buttons.includes('Close'), JSON.stringify(said))
        const shown = [said.origin, said.title, said.message, said.detail].join('\n')
        check('the consent question names the origin once', said.origin.length > 0 && shown.split(said.origin).length === 2, JSON.stringify(said))
        const grantFit = await panelFits(grant)
        check('the consent card sits inside its view, uncut and unscrolled', grantFit.fits, grantFit.detail)
        await state(check, app, `question-consent-${scheme}`, {
          expected: 'A question panel floats over the page, directly under the address pill with its top edge crossing into the toolbar: a header naming the 127.0.0.1 origin that is asking, a message about what the app wants, a switch row for each permission the app asks for, all off, the claimed name of the app and, because this is the first question of the profile, the line "This is a desktop app. It needs more than a web page may have, so it asks you once." just above two readable buttons, Close as plain text and Grant all, the filled one. Text and buttons are fully inside the panel in this colour scheme, nothing is cut, and the page and toolbar stay visible around it.',
          action: 'Typed the address of a loopback app that advertises a manifest and waited for its grant question to arm.',
          ignore: [FIXTURE_ADDRESS, CONSENT_ORIGIN_LINE]
        })
        await answerQuestion(app, 'Close')
        await chrome.waitForSelector('#site-permissions-btn[data-missing]', { timeout: 20_000 })
        await state(check, app, `key-dot-${scheme}`, {
          expected: 'The address pill after the question was closed with every switch off: the key beside the address wears a small filled dot in the accent colour at its bottom right, fully inside the pill and clear of the key glyph, and nothing else on the pill changed. The dot reads clearly against the pill in this colour scheme.',
          action: 'Closed the consent question with no switch on and waited for the key to show its dot.',
          ignore: [FIXTURE_ADDRESS]
        })

        await chrome.click('#site-permissions-btn')
        expect(await waitFor(async () => await popoverShown(app, '/site-info/'))).toBe(true)
        const panel = app.windows().find((w) => w.url().includes('/site-info/'))
        expect(await waitFor(async () => (await panel?.$$('#report-problem'))?.length === 1)).toBe(true)
        await state(check, app, `site-info-report-problem-${scheme}`, {
          expected: 'The popup under the key starts with the connection card row (the Web3 Score line inside it), then lists the app\'s permission row with its switch off, a "Permissions" group saying the site has not asked for anything with an "Add a permission..." row, then the Cookies and site data and Site settings rows, and last a row reading "Report a problem with this site" with a chevron at the right, in the same type, spacing and colours as the rows above it. The row is fully inside the popup, uncut, and readable in this colour scheme.',
          action: 'Clicked the key on the consent fixture, whose manifest names where problems are reported.',
          ignore: [FIXTURE_ADDRESS, SITE_INFO_ORIGIN_LINE]
        })
        await chrome.click('#site-permissions-btn')
        expect(await waitFor(async () => !(await popoverShown(app, '/site-info/')))).toBe(true)

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

  it.skipIf(!localFilesServed)(`a local file's question and its mark look right (${scheme})`, async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-visual-local-')))
    writeFileSync(join(folder, 'orivon.json'), MANIFEST)
    writeFileSync(join(folder, 'app.html'), '<!doctype html><meta charset="utf-8"><title>Local fixture</title><link rel="orivon-manifest" href="orivon.json"><body style="font:16px sans-serif;margin:32px"><h1>Local fixture</h1><p>A file on this computer.</p>')
    const { app, chrome } = await launchShell({ scheme })
    try {
      await stubNativeDialogs(app)
      await runPhase('visual states of a local file', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await prepareWindow(app)

        await clickAddressBarRetrying(chrome, join(folder, 'app.html'))
        const grant = await waitQuestion(app)
        await grant.waitForSelector('.q:not(.arming)')
        const said = await readQuestion(grant)
        check('the question is a warning that names the file and offers Don\'t allow and a press-twice Allow', said.warning && said.title === 'Let a file on this computer use Orivon permissions?' && said.buttons.join('|') === "Don't allow|Allow (press twice)", JSON.stringify(said))
        const grantFit = await panelFits(grant)
        check('the card sits inside its view, uncut and unscrolled', grantFit.fits, grantFit.detail)
        await state(check, app, `local-file-question-${scheme}`, {
          expected: 'A question panel in the warning style floats under the address pill: a header with the path of a file on this computer, the title "Let a file on this computer use Orivon permissions?", a message saying Orivon cannot check files on the computer and that whoever can change the file can change what it does, a list with one row for storing files, and two buttons, Don\'t allow and Allow (press twice), the second the filled one. Text is fully inside the panel in this colour scheme and nothing is cut.',
          action: 'Typed the path of an HTML file that links a manifest and waited for its question to arm.',
          ignore: [{ x: 240, y: 44, width: 400, height: 24 }, { x: 188, y: 78, width: 320, height: 20 }]
        })
        await answerQuestion(app, "Don't allow")

        await delay(ABSENCE_SETTLE_MS)
        await state(check, app, `local-file-mark-${scheme}`, {
          expected: 'The tab shows a plain page headed "Local fixture". In the address bar a small file icon and the words "Local file" come before the dimmed file path; there is no lock and no "Not secure" warning.',
          action: 'Declined the question, so the page stays an ordinary local file.',
          ignore: [{ x: 240, y: 44, width: 400, height: 24 }]
        })
        check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
      })
    } finally {
      await closeElectron(app)
      rmSync(folder, { recursive: true, force: true })
    }
  }, QA_TEST_TIMEOUT_MS)

  it(`the screen-share picker and the sharing bar look right (${scheme})`, async () => {
    const sharing = await startServer((_req, res) => {
      html(res, `<!doctype html><meta charset="utf-8"><title>Sharing fixture</title><body style="font:16px sans-serif;margin:32px"><h1>Sharing fixture</h1><button id="go">Share</button>
<script>
window.__r = {}
document.getElementById('go').addEventListener('click', () => window.__next())
window.__next = () => {}
window.share = (options) => navigator.mediaDevices.getDisplayMedia(options).then((stream) => { stream.getVideoTracks()[0].addEventListener('ended', () => { window.__r.ended = (window.__r.ended || 0) + 1 }); window.__r.state = stream.getVideoTracks()[0].readyState }, (error) => { window.__r.state = 'ERR:' + error.name })
</script>`)
    })
    const { app, chrome } = await launchShell({ scheme })
    try {
      await runPhase('visual states of the screen-share picker and bar', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        await prepareWindow(app)
        const view = await visit(app, chrome, `${sharing.origin}/`)
        await chrome.click('#new-tab')
        await clickAddressBarRetrying(chrome, `${server.origin}/`)
        expect((await waitForTab(chrome, { address: `${server.origin}/` })).ok).toBe(true)
        await chrome.evaluate(() => { document.querySelector<HTMLElement>('.tab')?.click() })
        expect(await waitFor(() => findViewShowing(app, chrome, `${sharing.origin}/`) !== undefined)).toBe(true)

        const asking = async (options: string): Promise<Page> => {
          await view.evaluate((code) => { (window as unknown as { __next: () => void }).__next = new Function(code) as () => void }, `window.share(${options})`)
          await view.click('#go')
          let picker: Page | undefined
          expect(await waitFor(async () => {
            picker = app.windows().find((page) => page.url().includes('overlay=screen-share-picker') && !page.isClosed())
            try { await picker?.waitForSelector('.picker-card', { timeout: 1_000 }); return picker !== undefined } catch { return false }
          }, 20_000)).toBe(true)
          return picker as Page
        }

        const picker = await asking('{ video: true }')
        await picker.waitForSelector('.picker:not(.arming)')
        check('the picker names the site, offers three segments, two tab cards with This tab first, and no Share yet', await picker.evaluate(() => ({
          title: document.querySelector('.sheet-title')?.textContent ?? '',
          segments: [...document.querySelectorAll('.picker-segments button')].map((b) => b.textContent),
          cards: [...document.querySelectorAll('.picker-card .picker-label')].map((l) => l.textContent),
          self: document.querySelector('.picker-card .picker-self')?.textContent ?? '',
          share: (document.querySelector('.btn-row .btn.primary') as HTMLButtonElement).disabled
        })).then((r) => r.title.startsWith('Choose what to share with') && r.segments.join() === 'Tab,Window,Entire screen' && r.cards.length === 2 && r.self === 'This tab' && r.share), 'picker content')
        const fit = await picker.evaluate(() => { const root = document.documentElement; return root.scrollHeight <= root.clientHeight && root.scrollWidth <= root.clientWidth })
        check('the picker sits inside its view, uncut and unscrolled', fit)
        await picker.locator('.picker-card').nth(1).click()
        await state(check, app, `screen-share-picker-${scheme}`, {
          expected: 'A sheet floats over the page, centred in the page area: the title "Choose what to share with <127.0.0.1 origin>", three segments Tab, Window and Entire screen with Tab selected, a grid of two cards each with a pale picture area and a label, the first marked "This tab" and showing a small real picture of the page behind, and the second (the other tab) showing a plain icon and selected with the accent colour, then Cancel and a filled Share button. Text, cards and buttons are fully inside the sheet and readable in this colour scheme.',
          action: 'Pressed Share on a loopback page that calls getDisplayMedia, with a second tab open, and chose the second card.',
          // The origin in the title and on the second card change with the port; the first card's thumbnail is a live capture of the page behind.
          ignore: [FIXTURE_ADDRESS, { x: 336, y: 296, width: 372, height: 18 }, { x: 545, y: 506, width: 190, height: 18 }, { x: 346, y: 377, width: 182, height: 103 }]
        })
        await picker.keyboard.press('Escape').catch(() => {})
        expect(await waitFor(() => app.windows().every((page) => !page.url().includes('overlay=screen-share-picker')))).toBe(true)

        const screenPicker = await asking("{ video: { displaySurface: 'monitor' } }")
        await screenPicker.locator('.picker-segments button', { hasText: 'Entire screen' }).waitFor()
        await screenPicker.waitForSelector('.picker-segments button[aria-selected="true"]:has-text("Entire screen")')
        await screenPicker.waitForSelector('.picker-card')
        await screenPicker.click('.picker-card')
        await screenPicker.waitForSelector('.picker:not(.arming)')
        await screenPicker.click('.btn-row .btn.primary')
        await view.waitForFunction(() => (window as unknown as { __r: { state?: string } }).__r.state === 'live', undefined, { timeout: 30_000 })
        let bar: Page | undefined
        expect(await waitFor(async () => {
          bar = app.windows().find((page) => page.url().includes('overlay=sharing-bar') && !page.isClosed())
          try { await bar?.waitForSelector('.sharing-text', { timeout: 1_000 }); return bar !== undefined } catch { return false }
        }, 20_000)).toBe(true)
        const text = (await (bar as Page).textContent('.sharing-text')) ?? ''
        check('the sharing bar says who is sharing what and offers Stop sharing and Hide', /is sharing your screen$/.test(text) && await (bar as Page).locator('text=Stop sharing').count() === 1 && await (bar as Page).locator('button[aria-label="Hide this bar"]').count() === 1, text)
        check('the address bar carries the sharing chip and the tab the sharing mark', await chrome.evaluate(() => (document.querySelector('#sharing-chip') as HTMLElement | null)?.hidden === false && document.querySelector('.tab.active .tab-share.sharing') !== null), 'chip and tab mark')
        await state(check, app, `sharing-bar-${scheme}`, {
          expected: 'A one-row bar floats at the top centre of the page area: a small red screen mark, the text "<127.0.0.1 origin> is sharing your screen", a red-outlined Stop sharing button and a close button. In the toolbar a red screen chip sits in the address pill, and the active tab shows a small red screen mark before its close button. Everything is readable in this colour scheme and nothing is cut.',
          action: 'Chose the entire screen in the picker and pressed Share.',
          ignore: [FIXTURE_ADDRESS, { x: 330, y: 100, width: 340, height: 30 }]
        })
        // Stop sharing closes the bar's own page, so the click can end with the page gone and says nothing: the page's track has not ended just before the press and has ended after it.
        expect(await view.evaluate(() => (window as unknown as { __r: { ended?: number } }).__r.ended)).toBeUndefined()
        await (bar as Page).click('text=Stop sharing').catch((error: unknown) => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error })
        await view.waitForFunction(() => (window as unknown as { __r: { ended?: number } }).__r.ended === 1, undefined, { timeout: 30_000 })
        expect(await waitFor(() => app.windows().every((page) => !page.url().includes('overlay=sharing-bar')))).toBe(true)
      })
    } finally {
      await closeElectron(app)
      await sharing.close()
    }
  }, QA_TEST_TIMEOUT_MS * 2)

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
        check('the key, the tunnel button and the Web2 pill stay away from a Settings page', !(await chrome.locator('#site-permissions-btn').isVisible()) && !(await chrome.locator('#tunnel-btn').isVisible()) && !(await chrome.locator('#web3-mark').isVisible()))
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

        const links = await visit(app, chrome, `${server.origin}/links`)
        await prepareWindow(app)
        await links.hover('#next')
        expect(await waitFor(async () => await app.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0]?.contentView.children ?? []).some((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes('overlay=link-status') === true && child.getVisible() && child.getBounds().width > 0)))).toBe(true)
        expect(await popupSized(app, 'overlay=link-status')).toBe(true)
        await state(check, app, `link-bubble-${scheme}`, {
          expected: 'A page headed "Links page" with one link under it fills the page area. In its bottom-left corner, flush against the window\'s left and bottom edges, is a one-line bubble in the panel colour with a thin border along its top and right edges, a rounded top-right corner and square other corners, which reads the link\'s address (http://127.0.0.1:<port>/next-page) in secondary-colour text, whole and unclipped. The bubble is no wider than its text and covers no control.',
          action: 'Opened the links page in the front tab and pointed at its link.',
          pointer: 'keep',
          ignore: [FIXTURE_ADDRESS, { x: 0, y: 776, width: 420, height: 24 }]
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
