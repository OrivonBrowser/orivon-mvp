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
// That promise is load-bearing and used to be breakable: a click on a selector
// that could not match blocked until Playwright gave up, the throw escaped
// main(), and the run printed a bare stack trace with no results at all. Two
// things stop that now -- every click goes through clickChecked() below, and
// the whole body is wrapped so a throw becomes a failed check and the results
// are still printed.
//
// HERMETIC BY CONSTRUCTION. Every navigation resolves to 127.0.0.1, and the
// one non-local hostname this file types (duckduckgo.com) is blackholed at the
// resolver. See the search section near the bottom for why that costs no
// coverage. `npm run smoke` must pass on an air-gapped machine.
import { createServer } from 'node:http'
import { launchElectron } from '../test/launch-electron.mjs'

/** Where the omnibox sends non-address input (src/main/omnibox.ts). */
const SEARCH_HOST = 'duckduckgo.com'

/** Ceiling on waitFor(). Every state push in this shell lands in
 * milliseconds; this only bounds the broken case, where the caller's own
 * check() then fails by name. */
const WAIT_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 50

function findChrome (app) {
  const win = app.windows().find((w) => w.url().endsWith('index.html'))
  if (win === undefined) throw new Error('chrome view not found in app.windows()')
  return win
}

/** The single tab view, as a Playwright page -- lets a check read the tab's
 * OWN location rather than trusting the toolbar's rendering of it (T25:
 * the address bar is a display layer and can lie independently). */
function findTabView (app, chrome) {
  return app.windows().find((w) => w !== chrome)
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

/**
 * Polls until `predicate` is true, or the ceiling is hit. Returns the outcome
 * as a boolean so the caller's own check() reports it by name.
 *
 * This replaces the fixed sleeps this file used to carry. A sleep is wrong in
 * both directions: too short and the next step reads stale state and blames
 * the product for a harness race, too long and every run pays for the worst
 * machine. Polling is faster in the normal case and correct in the slow one.
 */
async function waitFor (predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate() === true) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

async function activeTabInfo (chrome) {
  return chrome.evaluate(() => {
    const active = document.querySelector('.tab.active')
    return {
      // The tab strip's own id for the active tab (dataset['id'] in
      // renderTabs(), src/renderer/main.ts) -- lets checks address tabs by
      // identity instead of by ":not(.active)", which flips meaning the moment
      // the active tab changes and re-resolves against a strip that
      // replaceChildren()s on every state push.
      activeId: active?.dataset.id,
      title: active?.querySelector('.title')?.textContent,
      backDisabled: document.querySelector('#back')?.disabled,
      forwardDisabled: document.querySelector('#forward')?.disabled,
      // The address bar's own displayed value (renderToolbar() in
      // src/renderer/main.ts) -- what the checks below use to assert "which
      // URL", as distinct from "which title".
      address: document.querySelector('#address')?.value
    }
  })
}

/** Tab ids currently rendered in the tab strip, in strip order. */
async function tabIds (chrome) {
  return chrome.evaluate(() =>
    Array.from(document.querySelectorAll('.tab')).map((el) => el.dataset.id)
  )
}

/**
 * Waits until EVERY field of `expected` matches the shell's reported active
 * tab, and returns both the outcome and what was last seen.
 *
 * Wait for everything you are about to assert, in one predicate. The fields
 * arrive on different events -- the address on did-navigate, the title on
 * page-title-updated, the nav-button flags on whichever push lands last
 * (src/main/tabs.ts wires five separate emitState() triggers) -- so waiting
 * for one field and then reading another is a race that fails intermittently
 * and reads like a product bug. That is not hypothetical: an earlier draft of
 * this file did exactly that and a title assertion failed intermittently.
 */
async function waitForTab (chrome, expected) {
  let info
  const ok = await waitFor(async () => {
    info = await activeTabInfo(chrome)
    return Object.entries(expected).every(([field, value]) => info[field] === value)
  })
  return { ok, info }
}

/**
 * page.evaluate(), retrying while the page's execution context is being torn
 * down.
 *
 * A navigation commit destroys the old context, and a read that lands inside
 * that window throws "Execution context was destroyed". That is a harness
 * race, not a product fact, and it must never be reported as one — before this
 * existed it surfaced as the whole run failing with a stack trace, roughly one
 * run in three. Only that specific class is retried; every other error still
 * propagates.
 */
async function evaluateRetrying (page, fn, timeoutMs = WAIT_TIMEOUT_MS) {
  const TRANSIENT = /Execution context was destroyed|frame was detached|Target closed|Target page.*closed/i
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await page.evaluate(fn)
    } catch (e) {
      if (Date.now() >= deadline || !TRANSIENT.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
}

/**
 * The tab's OWN location and title, waited until it settles on `expectedHref`.
 * Returns the last successful read either way, so a check that fails still has
 * a real value to report rather than a race to explain.
 */
async function readTabDocument (app, chrome, expectedHref) {
  let seen
  await waitFor(async () => {
    const view = findTabView(app, chrome)
    if (view === undefined) return false
    try {
      seen = await evaluateRetrying(view, () => ({ href: location.href, title: document.title }))
    } catch {
      return false
    }
    return seen.href === expectedHref
  })
  return seen
}

/** Compact "wanted X, saw Y" for a failed check's detail field. */
function mismatch (expected, info) {
  const seen = Object.fromEntries(Object.keys(expected).map((field) => [field, info?.[field]]))
  return `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`
}

async function main () {
  const result = { checks: [], leakChecks: [] }
  const failures = []
  const check = (name, cond, detail) => {
    result.checks.push(detail === undefined ? { name, pass: cond } : { name, pass: cond, detail })
    if (!cond) failures.push(detail === undefined ? name : `${name} -- ${detail}`)
  }

  /**
   * A click that records a named failure instead of throwing when its selector
   * cannot match. Some selectors here are legitimately absent when something
   * upstream regressed (an empty tab strip has no `.tab.active .close`), and
   * that is exactly when this file's JSON result matters most.
   */
  const clickChecked = async (page, selector, name) => {
    try {
      await page.click(selector)
      return true
    } catch (e) {
      check(name, false, `click on \`${selector}\` failed: ${String(e).split('\n')[0]}`)
      return false
    }
  }

  const { server, urlFor } = await startFixtureServer()
  const app = await launchElectron({
    appPath: '.',
    // Blackhole the search host at the resolver. The search check near the
    // bottom asserts the TARGET url, which Chromium commits whether or not the
    // load succeeds -- so this costs no coverage and buys a run that cannot
    // reach the network, cannot leak the query, and cannot be turned red by a
    // captive portal. Read that section before removing this.
    args: [`--host-resolver-rules=MAP ${SEARCH_HOST} ~NOTFOUND`]
  })

  try {
    await new Promise((r) => setTimeout(r, 1000))

    check('exactly two windows on launch (chrome + one default tab)', app.windows().length === 2)

    const leakCheck = async (label) => {
      for (const win of app.windows()) {
        const leak = await evaluateRetrying(win, () => ({
          url: location.href,
          leakedRequire: typeof globalThis.require,
          leakedProcess: typeof globalThis.process
        }))
        result.leakChecks.push({ when: label, ...leak })
        check(`no require() leak in ${leak.url} (${label})`, leak.leakedRequire === 'undefined')
        check(`no process leak in ${leak.url} (${label})`, leak.leakedProcess === 'undefined')
      }
    }
    await leakCheck('on launch')

    const chrome = findChrome(app)

    /** Types into the address bar and presses Enter, then waits for the shell
     * to report every field the caller is about to assert. */
    const navigateTo = async (input, expected) => {
      await chrome.click('#address')
      await chrome.fill('#address', input)
      await chrome.press('#address', 'Enter')
      return waitForTab(chrome, expected)
    }

    /** check() over a waitForTab() result, with "wanted X, saw Y" on failure. */
    const checkTab = (name, expected, { ok, info }) =>
      check(name, ok, ok ? undefined : mismatch(expected, info))

    const wantA = { address: urlFor('/a'), title: 'fixture-a' }
    checkTab('address-bar navigation loaded fixture A (URL and title)', wantA, await navigateTo(urlFor('/a'), wantA))

    const wantB = { address: urlFor('/b'), title: 'fixture-b', backDisabled: false }
    checkTab(
      'address-bar navigation loaded fixture B, and back became enabled',
      wantB,
      await navigateTo(urlFor('/b'), wantB)
    )

    await clickChecked(chrome, '#back', 'the back button is clickable')
    const wantBack = { address: urlFor('/a'), title: 'fixture-a', forwardDisabled: false }
    checkTab(
      'back button returned to fixture A, and forward became enabled',
      wantBack,
      await waitForTab(chrome, wantBack)
    )

    await clickChecked(chrome, '#forward', 'the forward button is clickable')
    const wantFwd = { address: urlFor('/b'), title: 'fixture-b' }
    checkTab('forward button returned to fixture B', wantFwd, await waitForTab(chrome, wantFwd))

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

    const resized = await waitFor(async () =>
      (await chrome.evaluate(() => window.innerWidth)) === targetWidth
    )
    const chromeViewport = await chrome.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    check(
      `chrome view tracks resize (width ${chromeViewport.w} === ${targetWidth})`,
      resized && chromeViewport.w === targetWidth
    )

    const tabView = findTabView(app, chrome)
    if (tabView === undefined) {
      check('a tab view exists to check resize on', false)
    } else {
      const tabViewport = await evaluateRetrying(tabView, () => ({ w: window.innerWidth, h: window.innerHeight }))
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
    // Everything above exercised a single tab. back()/forward()
    // (src/main/tabs.ts) act on ONE tab's own navigationHistory -- prove that
    // switching tabs shows each tab exactly as it was left, in both
    // directions, after driving the OTHER tab's history around.
    //
    // Scope note, so this is not read as more than it is: each WebContentsView
    // owns its navigationHistory by construction, so a literal shared-history
    // regression is not reachable from the current code. What these checks
    // genuinely guard is the layer that CAN regress -- activateTab() and the
    // ShellState push that repaints the toolbar for the newly active tab.
    // Storage isolation is a different property with no coverage here: every
    // tab shares session.defaultSession (no `partition` in tabs.ts), which is
    // correct at build step 1 and becomes a real requirement at step 4.
    const newTabClicked = await clickChecked(chrome, '#new-tab', 'the new-tab button is clickable')
    const twoTabs = newTabClicked && await waitFor(async () => (await tabIds(chrome)).length === 2)
    check('opening a new tab makes two tabs', twoTabs)

    if (!twoTabs) {
      // Everything below drives a two-tab strip. Running it anyway would spend
      // the click ceiling on each selector in turn and report a cascade of
      // failures that all restate this one.
      check('the two-tab and last-tab-close checks could run', false, 'the tab strip never reached two tabs')
    } else {
      const [tab1Id, tab2Id] = await tabIds(chrome)

      // Wait for the new tab to actually BE the active one before typing.
      // The renderer's submit handler reads currentState.activeTabId
      // (src/renderer/main.ts), so typing before that push lands would
      // navigate tab 1 and blame tab 2 for the result.
      const wantNewActive = { activeId: tab2Id }
      checkTab(
        'the new tab becomes the active one before anything is typed into it',
        wantNewActive,
        await waitForTab(chrome, wantNewActive)
      )

      const wantC = { activeId: tab2Id, address: urlFor('/c'), title: 'fixture-c' }
      checkTab('tab 2 address-bar navigation loaded fixture C', wantC, await navigateTo(urlFor('/c'), wantC))

      const wantD = { activeId: tab2Id, address: urlFor('/d'), title: 'fixture-d' }
      checkTab('tab 2 address-bar navigation loaded fixture D', wantD, await navigateTo(urlFor('/d'), wantD))

      await clickChecked(chrome, '#back', 'the back button is clickable with two tabs open')
      checkTab('tab 2 back returned to fixture C', wantC, await waitForTab(chrome, wantC))

      await clickChecked(chrome, '#forward', 'the forward button is clickable with two tabs open')
      checkTab('tab 2 forward returned to fixture D', wantD, await waitForTab(chrome, wantD))

      // Switch to tab 1 with a real click on the tab strip (this file's "real
      // clicks, not injected commands" rule), addressed by id rather than by
      // ":not(.active)". Tab 1 was left at the TIP of about:blank -> /a -> /b
      // by the single-tab checks above (it went back to A, then forward to B
      // again) -- so back is available and forward is not.
      await clickChecked(chrome, `[data-id="${tab1Id}"] .title`, 'tab 1 is clickable in the tab strip')
      const wantTab1 = {
        activeId: tab1Id,
        title: 'fixture-b',
        address: urlFor('/b'),
        backDisabled: false,
        forwardDisabled: true
      }
      checkTab(
        "switching to tab 1 shows it exactly as left -- tab 2's navigation did not reach it",
        wantTab1,
        await waitForTab(chrome, wantTab1)
      )

      // Reverse direction, asserting the SAME five fields -- "exactly as left"
      // has to mean the same thing both ways. Tab 2 sits at the tip of
      // about:blank -> /c -> /d, so back is available and forward is not; an
      // earlier draft omitted forwardDisabled here, which is the one field a
      // history leak would move.
      await clickChecked(chrome, `[data-id="${tab2Id}"] .title`, 'tab 2 is clickable in the tab strip')
      const wantTab2 = {
        activeId: tab2Id,
        title: 'fixture-d',
        address: urlFor('/d'),
        backDisabled: false,
        forwardDisabled: true
      }
      checkTab(
        'switching back to tab 2 shows it exactly as left -- visiting tab 1 did not reach it',
        wantTab2,
        await waitForTab(chrome, wantTab2)
      )

      // Tabs created after launch go through the same createTab() path, but
      // nothing had re-checked the privilege boundary on one. Cheap to redo.
      await leakCheck('with a second tab open')

      // ---- Closing the last tab ------------------------------------------
      // OPEN QUESTION A16 (docs/open-questions.md): what closing the last tab
      // SHOULD do is not decided. TabManager.closeTab() currently leaves the
      // BaseWindow open with zero tabs and activeTabId: null; Chrome and
      // Firefox instead open a fresh tab or close the window. So the checks
      // below are split deliberately:
      //
      //   - Properties that hold under ANY resolution of A16 are asserted as
      //     requirements: no crash, no orphaned view, and the shell still
      //     usable afterwards.
      //   - The zero-tabs outcome itself is recorded as CURRENT BEHAVIOUR
      //     pending A16, not as a specification. If A16 resolves the other
      //     way, change that check -- not the product.
      //
      // Close the other tab first, addressed by id, so the next close is
      // unambiguously "the last tab" rather than "one of several".
      await clickChecked(chrome, `[data-id="${tab1Id}"] .close`, "tab 1's close button is clickable")
      check(
        'one tab remains after closing the other',
        await waitFor(async () => (await tabIds(chrome)).length === 1)
      )
      check(
        'exactly two windows remain (chrome + the one surviving tab)',
        await waitFor(() => app.windows().length === 2)
      )

      // Now close it -- the actual last tab.
      await clickChecked(chrome, `[data-id="${tab2Id}"] .close`, "the last tab's close button is clickable")

      let mainProcessError
      try {
        await app.evaluate(({ app: electronApp }) => electronApp.getVersion())
      } catch (e) {
        mainProcessError = String(e).split('\n')[0]
      }
      check(
        'closing the last tab does not crash the app (main process still responds)',
        mainProcessError === undefined,
        mainProcessError
      )

      // Stated as a RATIO, not a count: every open window must be accounted
      // for by the tab strip (one chrome view + one view per tab). That is the
      // actual no-orphan invariant, and unlike `length === 1` it holds however
      // A16 resolves -- an auto-opened replacement tab is accounted for, a
      // leaked WebContentsView is not.
      check(
        'closing the last tab leaves no stray/orphaned window behind',
        await waitFor(async () => app.windows().length === (await tabIds(chrome)).length + 1)
      )

      const emptyStrip = await waitFor(async () => (await tabIds(chrome)).length === 0)
      check(
        'closing the last tab clears the tab strip (CURRENT BEHAVIOUR, pending A16 -- not a spec)',
        emptyStrip
      )

      const wantNoNav = { backDisabled: true, forwardDisabled: true }
      checkTab(
        'back/forward are disabled with nothing to navigate',
        wantNoNav,
        await waitForTab(chrome, wantNoNav)
      )

      // The part that holds under any resolution of A16: whatever the shell
      // shows after the last tab closes, it must not be a dead end. Counted
      // relative to whatever is on screen, for the same reason as above.
      const tabsBeforeRecovery = (await tabIds(chrome)).length
      await clickChecked(chrome, '#new-tab', 'the new-tab button is clickable after the last tab closed')
      check(
        'the shell recovers: a new tab opens fine after the last one closed',
        await waitFor(async () => (await tabIds(chrome)).length === tabsBeforeRecovery + 1)
      )
      check(
        'every window is still accounted for by the tab strip after recovering',
        await waitFor(async () => app.windows().length === (await tabIds(chrome)).length + 1)
      )
    }

    // ---- Address-bar text that is not a URL resolves to a search ---------
    // Owner decision, build step 1 (mvp-scope.md IN table; build-plan.md's
    // "Sequence" step 1): non-address input is sent to DuckDuckGo -- a stated
    // known limitation, since in the PRODUCT the search text leaves the
    // machine.
    //
    // What this check proves, precisely: parseOmniboxInput's `search` branch
    // reaches loadURL with the exact right target, through the real
    // renderer -> IPC -> TabManager path. What it does NOT prove, and cannot,
    // is that DuckDuckGo answered -- the address bar reads
    // webContents.getURL(), and Chromium commits the REQUESTED url even when
    // it serves an error page instead. An earlier version of this check
    // claimed to exercise a real network round trip and forbade "mocking" it;
    // that claim was simply false -- it passed identically with DNS
    // blackholed, which is how the discrepancy was found.
    //
    // So the host is now blackholed on purpose (see the launch args above).
    // Identical coverage, nothing leaves the machine, and a captive portal or
    // a DuckDuckGo redirect can no longer turn this red for a reason that has
    // nothing to do with Orivon. Making it a genuine round-trip test would
    // mean asserting the LOADED PAGE, not the address bar -- that is a
    // different check, and it would forfeit running offline and in CI.
    const SEARCH_QUERY = 'orivon browser smoke check'
    const expectedSearchUrl = `https://${SEARCH_HOST}/?q=${encodeURIComponent(SEARCH_QUERY).replace(/%20/g, '+')}`

    const wantSearch = { address: expectedSearchUrl }
    const search = await navigateTo(SEARCH_QUERY, wantSearch)

    let searchUrl
    try {
      searchUrl = new URL(search.info?.address ?? '')
    } catch {
      searchUrl = undefined
    }

    checkTab(
      'a plain-text address-bar entry resolves to a DuckDuckGo search, not a URL',
      wantSearch,
      search
    )
    check(
      'the DuckDuckGo query carries the exact typed text',
      searchUrl?.searchParams.get('q') === SEARCH_QUERY,
      searchUrl?.searchParams.get('q') === SEARCH_QUERY
        ? undefined
        : `q read ${JSON.stringify(searchUrl?.searchParams.get('q') ?? null)}`
    )

    // ---- Dangerous schemes typed into the address bar are refused --------
    // The address bar is chrome-privileged input: a scheme the shell will
    // navigate to here is a sandbox escape or a local-file disclosure one
    // keystroke away (src/main/omnibox.ts's own header; security-model.md
    // T1/T10). parseOmniboxInput is unit tested as a pure function, but until
    // now nothing exercised the WIRING -- renderer -> IPC ->
    // TabManager.resolveTarget -> loadURL. That gap is the dangerous one: a
    // future change adding scheme pass-through in tabs.ts (T23's magnet:
    // handling lands in exactly this code path) would keep every unit test
    // green while re-opening the hole.
    //
    // Rejected input falls back to NEW_TAB_URL, which renderToolbar renders as
    // an empty address bar. Each case asserts BOTH the shell's view and the
    // tab's own location, because a check that trusted the toolbar alone would
    // be blind to T25 -- and, for javascript:, the toolbar and the location
    // both stay put whether or not the script ran, so those cases assert that
    // the payload did not execute.
    //
    // `about:` is deliberately absent: its rejection and its fallback are both
    // about:blank, so the two are indistinguishable from outside the process.
    // It is covered in src/main/omnibox.test.ts and nowhere else, on purpose.
    const HOSTILE_INPUTS = [
      { input: "javascript:document.title='PWNED-JS'", marker: 'PWNED-JS' },
      { input: 'data:text/html,<title>PWNED-DATA</title>', marker: 'PWNED-DATA' },
      { input: 'file:///etc/passwd', marker: undefined }
    ]

    for (const { input, marker } of HOSTILE_INPUTS) {
      const scheme = input.split(':')[0]
      const refused = await navigateTo(input, { address: '' })
      const seen = await readTabDocument(app, chrome, 'about:blank')

      check(
        `the address bar refuses ${scheme}: and falls back to the new-tab page`,
        refused.ok && seen?.href === 'about:blank',
        refused.ok && seen?.href === 'about:blank'
          ? undefined
          : `address bar read ${JSON.stringify(refused.info?.address)}, tab location ${JSON.stringify(seen?.href)}`
      )
      if (marker !== undefined) {
        check(
          `${scheme}: payload did not execute in the tab`,
          seen !== undefined && seen.title !== marker,
          seen?.title === marker ? `tab title became ${JSON.stringify(marker)}` : undefined
        )
      }
    }
  } catch (e) {
    // The header of this file promises a JSON result and a failure list. A
    // throw is exactly when they are most useful, so it becomes a check rather
    // than replacing the output with a stack trace.
    check('the smoke script ran to completion without throwing', false, String(e?.stack ?? e))
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
  console.error('Smoke check crashed before it could report:', e)
  process.exit(1)
})
