// Real smoke check for build step 1's shell. Replaces spike/smoke-launch.mjs
// (throwaway, spike-only) -- this is the shell's own regression check,
// exercised against the actual built app via real clicks and typing, not
// injected commands.
//
// Per open-questions.md C6 (narrowed 2026-08-26): app.firstWindow() is not
// reliable here -- it depends on view-add order, an implementation detail,
// not a contract. Windows are matched by URL via app.windows() instead.
//
// Per CLAUDE.md's traps list: never trust an exit code alone -- this script
// prints a JSON result and a failure list; read them, not just the exit code.
import { createServer } from 'node:http'
import { launchElectron } from '../test/launch-electron.mjs'

function findChrome (app) {
  const win = app.windows().find((w) => w.url().endsWith('index.html'))
  if (win === undefined) throw new Error('chrome view not found in app.windows()')
  return win
}

async function startFixtureServer () {
  const pages = {
    '/a': '<title>fixture-a</title><body>fixture A</body>',
    '/b': '<title>fixture-b</title><body>fixture B</body>',
    '/c': '<title>fixture-c</title><body>fixture C</body>',
    '/d': '<title>fixture-d</title><body>fixture D</body>'
  }
  const server = createServer((req, res) => {
    const body = pages[req.url] ?? '<title>fixture-404</title>'
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, urlFor: (path) => `http://127.0.0.1:${port}${path}` }
}

async function navigateTo (chrome, url) {
  await chrome.click('#address')
  await chrome.fill('#address', url)
  await chrome.press('#address', 'Enter')
  await chrome.waitForTimeout(500)
}

async function activeTabInfo (chrome) {
  return chrome.evaluate(() => {
    const title = document.querySelector('.tab.active .title')?.textContent
    const backDisabled = document.querySelector('#back')?.disabled
    const forwardDisabled = document.querySelector('#forward')?.disabled
    // The address bar's own displayed value (renderToolbar() in
    // src/renderer/main.ts) -- what the checks below use to assert "which
    // URL", as distinct from "which title".
    const address = document.querySelector('#address')?.value
    return { title, backDisabled, forwardDisabled, address }
  })
}

/** Number of tabs currently rendered in the tab strip. */
async function tabCount (chrome) {
  return chrome.evaluate(() => document.querySelectorAll('.tab').length)
}

async function main () {
  const result = { checks: [], leakChecks: [] }
  const failures = []
  const check = (name, cond) => {
    result.checks.push({ name, pass: cond })
    if (!cond) failures.push(name)
  }

  const { server, urlFor } = await startFixtureServer()
  const app = await launchElectron({ appPath: '.' })

  try {
    await new Promise((r) => setTimeout(r, 1000))

    check('exactly two windows on launch (chrome + one default tab)', app.windows().length === 2)

    for (const win of app.windows()) {
      const leak = await win.evaluate(() => ({
        url: location.href,
        leakedRequire: typeof globalThis.require,
        leakedProcess: typeof globalThis.process
      }))
      result.leakChecks.push(leak)
      check(`no require() leak in ${leak.url}`, leak.leakedRequire === 'undefined')
      check(`no process leak in ${leak.url}`, leak.leakedProcess === 'undefined')
    }

    const chrome = findChrome(app)

    await navigateTo(chrome, urlFor('/a'))
    const afterA = await activeTabInfo(chrome)
    check('address-bar navigation loaded fixture A', afterA.title === 'fixture-a')

    await navigateTo(chrome, urlFor('/b'))
    const afterB = await activeTabInfo(chrome)
    check('address-bar navigation loaded fixture B', afterB.title === 'fixture-b')
    check('back is enabled after two navigations', afterB.backDisabled === false)

    await chrome.click('#back')
    await chrome.waitForTimeout(500)
    const afterBack = await activeTabInfo(chrome)
    check('back button returned to fixture A', afterBack.title === 'fixture-a')
    check('forward is enabled after going back', afterBack.forwardDisabled === false)

    await chrome.click('#forward')
    await chrome.waitForTimeout(500)
    const afterForward = await activeTabInfo(chrome)
    check('forward button returned to fixture B', afterForward.title === 'fixture-b')

    // Resize check -- verifies chrome + tab bounds actually track a window
    // resize (win.on('resize') -> layoutChrome() + tabs.layout() in
    // window.ts), via each view's OWN rendered viewport rather than reaching
    // into main-process internals. CHROME_HEIGHT (118) must stay in sync
    // with src/renderer/style.css's `html, body { height: 118px }`.
    const CHROME_HEIGHT = 118
    const targetWidth = 900
    const targetHeight = 700
    await app.evaluate(({ BaseWindow }, { w, h }) => {
      BaseWindow.getAllWindows()[0].setContentBounds({ x: 0, y: 0, width: w, height: h })
    }, { w: targetWidth, h: targetHeight })
    await chrome.waitForTimeout(300)

    const chromeViewport = await chrome.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    check(
      `chrome view tracks resize (width ${chromeViewport.w} === ${targetWidth})`,
      chromeViewport.w === targetWidth
    )

    const tabView = app.windows().find((w) => w !== chrome)
    if (tabView === undefined) {
      check('a tab view exists to check resize on', false)
    } else {
      const tabViewport = await tabView.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      check(
        `tab view width tracks resize (${tabViewport.w} === ${targetWidth})`,
        tabViewport.w === targetWidth
      )
      check(
        `tab view height is window height minus CHROME_HEIGHT (${tabViewport.h} === ${targetHeight - CHROME_HEIGHT})`,
        tabViewport.h === targetHeight - CHROME_HEIGHT
      )
    }

    // ---- Two tabs: back/forward per tab, no cross-tab history leak -------
    // Everything above exercised a single tab. The actual point of per-tab
    // history is that back()/forward() (src/main/tabs.ts) act on ONE tab's
    // own navigationHistory -- prove that switching tabs shows each tab
    // exactly as it was left, in both directions, after driving the OTHER
    // tab's history around.
    await chrome.click('#new-tab')
    await chrome.waitForTimeout(500)
    const tabCountAfterNewTab = await tabCount(chrome)
    check('opening a new tab makes two tabs', tabCountAfterNewTab === 2)

    await navigateTo(chrome, urlFor('/c'))
    const afterC = await activeTabInfo(chrome)
    check(
      'tab 2 address-bar navigation loaded fixture C (URL asserted)',
      afterC.title === 'fixture-c' && afterC.address === urlFor('/c')
    )

    await navigateTo(chrome, urlFor('/d'))
    const afterD = await activeTabInfo(chrome)
    check(
      'tab 2 address-bar navigation loaded fixture D (URL asserted)',
      afterD.title === 'fixture-d' && afterD.address === urlFor('/d')
    )

    await chrome.click('#back')
    await chrome.waitForTimeout(500)
    const tab2Back = await activeTabInfo(chrome)
    check('tab 2 back returned to fixture C (URL asserted)', tab2Back.address === urlFor('/c'))

    await chrome.click('#forward')
    await chrome.waitForTimeout(500)
    const tab2Forward = await activeTabInfo(chrome)
    check('tab 2 forward returned to fixture D (URL asserted)', tab2Forward.address === urlFor('/d'))

    // Switch to tab 1 with a real click on the tab strip (this file's "real
    // clicks, not injected commands" rule) -- it was left at fixture B, one
    // entry back, by the single-tab checks above. If tab 2's four
    // navigations just above had leaked into a shared history, this is
    // where it would show: wrong title, wrong address, or wrong
    // back/forward flags.
    await chrome.click('.tab:not(.active) .title')
    await chrome.waitForTimeout(500)
    const tab1Restored = await activeTabInfo(chrome)
    check(
      "switching to tab 1 shows it exactly as left -- tab 2's navigation did not leak into it",
      tab1Restored.title === 'fixture-b' &&
        tab1Restored.address === urlFor('/b') &&
        tab1Restored.backDisabled === false &&
        tab1Restored.forwardDisabled === true
    )

    // Reverse direction: switching back to tab 2 must not have lost or
    // altered ITS state either -- isolation has to hold both ways.
    await chrome.click('.tab:not(.active) .title')
    await chrome.waitForTimeout(500)
    const tab2Restored = await activeTabInfo(chrome)
    check(
      "switching back to tab 2 shows it exactly as left -- visiting tab 1 did not leak into it",
      tab2Restored.address === urlFor('/d') && tab2Restored.backDisabled === false
    )

    // ---- Closing the last tab: sane, not a crash, not a stray window -----
    // First close the other (inactive) tab, to get down to exactly one --
    // so the next close is unambiguously "the last tab", not "one of
    // several".
    await chrome.click('.tab:not(.active) .close')
    await chrome.waitForTimeout(500)
    const tabCountAfterOtherClose = await tabCount(chrome)
    check('one tab remains after closing the other', tabCountAfterOtherClose === 1)
    check('exactly two windows remain (chrome + the one surviving tab)', app.windows().length === 2)

    // Now close it -- the actual last tab.
    await chrome.click('.tab.active .close')
    await chrome.waitForTimeout(500)

    let mainProcessAlive = true
    try {
      await app.evaluate(({ app: electronApp }) => electronApp.getVersion())
    } catch {
      mainProcessAlive = false
    }
    check('closing the last tab does not crash the app (main process still responds)', mainProcessAlive)
    check('closing the last tab leaves no stray/orphaned window behind', app.windows().length === 1)

    const stateAfterLastClose = await chrome.evaluate(() => ({
      tabCount: document.querySelectorAll('.tab').length,
      backDisabled: document.querySelector('#back')?.disabled,
      forwardDisabled: document.querySelector('#forward')?.disabled
    }))
    check('closing the last tab clears the tab strip (no leftover empty tab)', stateAfterLastClose.tabCount === 0)
    check(
      'back/forward read as disabled with no active tab',
      stateAfterLastClose.backDisabled === true && stateAfterLastClose.forwardDisabled === true
    )

    // "Sane" means recoverable, not just non-crashing: the chrome view must
    // still be a live, usable shell, not a dead end with an empty content
    // pane and nothing the user can do about it.
    await chrome.click('#new-tab')
    await chrome.waitForTimeout(500)
    const recoveredTabCount = await tabCount(chrome)
    check('the shell recovers: a new tab opens fine after the last one closed', recoveredTabCount === 1)
    check('exactly two windows again after recovering with a new tab', app.windows().length === 2)

    // ---- Address-bar text that is not a URL goes to DuckDuckGo -----------
    // Owner decision, build step 1 (mvp-scope.md IN table; build-plan.md's
    // "Sequence" step 1): non-address input is sent to DuckDuckGo -- a
    // stated known limitation, not an oversight: search text leaves the
    // machine. Unlike every other check in this file, this one is a REAL
    // external network request rather than 127.0.0.1 -- that is the point
    // of the check. If this ever proves unreliable in some environment,
    // that is itself a real finding; it must not be quietly swapped for a
    // mocked assertion.
    const SEARCH_QUERY = 'orivon browser smoke check'

    await navigateTo(chrome, SEARCH_QUERY)
    let searchInfo = await activeTabInfo(chrome)
    // External round-trip: allow materially more time than the 500ms used
    // for the local fixture server above, polling so a fast response
    // doesn't cost extra wall-clock time.
    for (let i = 0; i < 10 && searchInfo.address?.startsWith('https://duckduckgo.com/') !== true; i++) {
      await chrome.waitForTimeout(500)
      searchInfo = await activeTabInfo(chrome)
    }

    let searchUrl
    try {
      searchUrl = new URL(searchInfo.address ?? '')
    } catch {
      searchUrl = undefined
    }

    check(
      'a plain-text address-bar entry is sent to DuckDuckGo, not treated as a URL',
      searchUrl?.hostname === 'duckduckgo.com'
    )
    check(
      'the DuckDuckGo query carries the exact typed text',
      searchUrl?.searchParams.get('q') === SEARCH_QUERY
    )
  } finally {
    await app.close()
    server.close()
  }

  console.log(JSON.stringify(result, null, 2))

  if (failures.length > 0) {
    console.error('\nSmoke check FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\nSmoke check passed.')
}

main().catch((e) => {
  console.error('Smoke check crashed:', e)
  process.exit(1)
})
