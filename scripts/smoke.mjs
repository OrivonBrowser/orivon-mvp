// Real smoke check for build step 1's shell. Replaces spike/smoke-launch.mjs
// (throwaway, spike-only) -- this is the shell's own regression check,
// exercised against the actual built app via real clicks and typing, not
// injected commands.
//
// Per open-questions.md C6 (narrowed 2026-08-26): app.firstWindow() is not
// reliable here -- it depends on view-add order, an implementation detail,
// not a contract. Windows are matched by URL via app.windows() instead.
//
// ---------------------------------------------------------------------------
// THREE RULES THIS FILE IS HELD TO. Each was learned by getting it wrong.
// ---------------------------------------------------------------------------
//
// 1. IT REPORTS, IT DOES NOT JUST EXIT. Per CLAUDE.md's traps list: never
//    trust an exit code alone -- this script prints a JSON result and a
//    failure list; read them, not just the exit code. That used to be
//    breakable: a click on a selector that could not match blocked until
//    Playwright gave up, the throw escaped main(), and nothing printed at
//    all. Now every interaction is bounded and error-trapped, the body is
//    wrapped, AND the report is printed BEFORE teardown -- because app.close()
//    can itself throw, most plausibly when the app has already died, which is
//    exactly the case the last-tab checks exercise.
//
// 2. NEVER WAIT FOR A CONDITION THE PRE-ACTION STATE ALREADY SATISFIES.
//    waitFor() returns the instant its predicate holds, so if it held before
//    the action fired, the assertion is a no-op that reports green. This is
//    subtle and it bit this file twice: "wait until the tab is at about:blank"
//    after a hostile URL, when the tab was ALREADY at about:blank, and
//    "wait until windows === tabs + 1" after closing a tab, when that was
//    ALREADY true before the close. Both passed while the exact regression
//    they existed to catch was present. Either establish an observable
//    TRANSITION first (park the tab somewhere else), or settle and read once.
//
// 3. ABSENCE OF AN EVENT CANNOT BE POLLED FOR. A refusal is a navigation that
//    must NOT happen. Polling cannot express that -- only waiting out the
//    window in which it could have happened, then reading. That is the one
//    place a fixed delay is the correct instrument rather than a lazy one;
//    everywhere else, wait for the condition.
//
// HERMETIC BY CONSTRUCTION. The resolver is configured so that NOTHING but
// 127.0.0.1 resolves -- not a per-host blackhole that a future edit could
// step around. `npm run smoke` passes on an air-gapped machine, and a change
// that made it depend on the network fails loudly here rather than quietly
// phoning out.
import { createServer } from 'node:http'
import { launchElectron } from '../test/launch-electron.mjs'

/** Where the omnibox sends non-address input (src/main/omnibox.ts). Only used
 * to build the expected URL -- the resolver rule below blackholes everything
 * that is not loopback, so changing this cannot cause real egress. */
const SEARCH_HOST = 'duckduckgo.com'

/**
 * Nothing resolves except loopback. Deliberately a whole-world blackhole
 * rather than `MAP duckduckgo.com ~NOTFOUND`: the property being protected is
 * "this run cannot reach the network", and a per-host rule only protects the
 * one host someone thought of. Verified: the full suite passes under this.
 */
const HERMETIC_RESOLVER = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'

/** Ceiling on waitFor(). Every state push in this shell lands in
 * milliseconds; this only bounds the broken case, where the caller's own
 * check() then fails by name. */
const WAIT_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 50

/**
 * How long to wait before concluding a navigation did NOT happen (rule 3).
 * Must comfortably exceed the time between `loadURL` being called and the
 * navigation committing. A deferred pass-through of only 300ms was enough to
 * slip past an earlier version of the deny-path checks.
 */
const ABSENCE_SETTLE_MS = 1_500

function findChrome (app) {
  const win = app.windows().find((w) => w.url().endsWith('index.html'))
  if (win === undefined) throw new Error('chrome view not found in app.windows()')
  return win
}

/** Non-chrome views, as Playwright pages -- lets a check read a tab's OWN
 * location rather than trusting the toolbar's rendering of it (T25: the
 * address bar is a display layer and can lie independently). */
function tabViews (app, chrome) {
  return app.windows().filter((w) => w !== chrome)
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Polls until `predicate` is true, or the ceiling is hit. Returns the outcome
 * as a boolean so the caller's own check() reports it by name.
 *
 * Read rule 2 in the header before using this. It is the right tool for "the
 * app should reach state X", and the wrong tool for "the app should stay in
 * state X" or "X should not happen".
 */
async function waitFor (predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate() === true) return true
    if (Date.now() >= deadline) return false
    await delay(POLL_INTERVAL_MS)
  }
}

/**
 * page.evaluate(), retrying while the page's execution context is being torn
 * down.
 *
 * A navigation commit destroys the old context, and a read that lands inside
 * that window throws "Execution context was destroyed". That is a harness
 * race, not a product fact, and it must never be reported as one -- before
 * this existed it surfaced as the whole run dying with a stack trace, roughly
 * one run in three. Only that specific class is retried; every other error
 * still propagates.
 */
async function evaluateRetrying (page, fn, timeoutMs = WAIT_TIMEOUT_MS) {
  const TRANSIENT = /Execution context was destroyed|frame was detached/i
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await page.evaluate(fn)
    } catch (e) {
      if (Date.now() >= deadline || !TRANSIENT.test(String(e))) throw e
      await delay(POLL_INTERVAL_MS)
    }
  }
}

/**
 * The Playwright page for the tab view currently showing `url`.
 *
 * Identifies a tab by what it displays rather than by being "the only one".
 * `find(w => w !== chrome)` is ambiguous the moment a second view exists --
 * which happens if A16 resolves to an auto-opened replacement tab, or if a
 * view leaks -- and reading the wrong window produces confidently-worded
 * failures against the wrong target.
 */
function findViewShowing (app, chrome, url) {
  return tabViews(app, chrome).find((w) => w.url() === url)
}

/** ONE read of a tab view's own location and title. Deliberately not a poll --
 * a caller asserting an absence must settle first, then read once (rule 3). */
async function readTabDocument (view) {
  if (view === undefined) return undefined
  return evaluateRetrying(view, () => ({ href: location.href, title: document.title }))
}

async function activeTabInfo (chrome) {
  return evaluateRetrying(chrome, () => {
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
  return evaluateRetrying(chrome, () =>
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
 * and reads like a product bug.
 */
async function waitForTab (chrome, expected) {
  let info
  const ok = await waitFor(async () => {
    info = await activeTabInfo(chrome)
    return Object.entries(expected).every(([field, value]) => info[field] === value)
  })
  return { ok, info }
}

/** Compact "wanted X, saw Y" for a failed check's detail field. */
function mismatch (expected, info) {
  const seen = Object.fromEntries(Object.keys(expected).map((field) => [field, info?.[field]]))
  return `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`
}

async function main () {
  const result = { checks: [], leakChecks: [], skipped: [] }
  const failures = []
  const check = (name, cond, detail) => {
    result.checks.push(detail === undefined ? { name, pass: cond } : { name, pass: cond, detail })
    if (!cond) failures.push(detail === undefined ? name : `${name} -- ${detail}`)
  }
  /** Records that a whole group of checks did not run, so a consumer can tell
   * a partial run from a full one instead of inferring it from a count. */
  const skip = (section, reason) => {
    result.skipped.push({ section, reason })
    check(`section "${section}" could run`, false, reason)
  }

  /**
   * A click that records a named failure instead of throwing when its selector
   * cannot match. Some selectors here are legitimately absent when something
   * upstream regressed (an empty tab strip has no `.close` button), and that
   * is exactly when this file's JSON result matters most.
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
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })

  try {
    const bothWindows = await waitFor(() => app.windows().length === 2)
    check(
      'exactly two windows on launch (chrome + one default tab)',
      bothWindows,
      bothWindows ? undefined : `saw ${app.windows().length} window(s)`
    )

    const chrome = findChrome(app)

    /** Asserts the leak checks covered every window, not just whichever
     * happened to have attached -- otherwise a slow tab attach silently
     * shrinks the only security-relevant coverage in this file to nothing,
     * and still reports green. */
    const leakCheck = async (label, expectedWindows) => {
      const windows = app.windows()
      check(
        `leak checks cover all ${expectedWindows} windows (${label})`,
        windows.length === expectedWindows,
        windows.length === expectedWindows ? undefined : `saw ${windows.length}`
      )
      for (const win of windows) {
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
    await leakCheck('on launch', 2)

    /** Types into the address bar and presses Enter, then waits for the shell
     * to report every field the caller is about to assert. The typing itself
     * is error-trapped so a regression in `#address` is a named failure rather
     * than an abort. */
    const navigateTo = async (input, expected) => {
      try {
        await chrome.click('#address')
        await chrome.fill('#address', input)
        await chrome.press('#address', 'Enter')
      } catch (e) {
        check(`address bar accepts typing (${input.slice(0, 40)})`, false, String(e).split('\n')[0])
        return { ok: false, info: undefined }
      }
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
      (await evaluateRetrying(chrome, () => window.innerWidth)) === targetWidth
    )
    const chromeViewport = await evaluateRetrying(chrome, () => ({ w: window.innerWidth, h: window.innerHeight }))
    check(
      `chrome view tracks resize (width ${chromeViewport.w} === ${targetWidth})`,
      resized && chromeViewport.w === targetWidth
    )

    const [tabView] = tabViews(app, chrome)
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
      skip('two tabs + last-tab close', 'the tab strip never reached two tabs')
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
      // nothing had re-checked the privilege boundary on one.
      await leakCheck('with a second tab open', 3)

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

      // The strip settling is the observable consequence of the close, so it
      // is established FIRST -- it is what makes the orphan read below a read
      // of the post-close state rather than of the pre-close one.
      const emptyStrip = await waitFor(async () => (await tabIds(chrome)).length === 0)
      check(
        'closing the last tab clears the tab strip (CURRENT BEHAVIOUR, pending A16 -- not a spec)',
        emptyStrip
      )

      // Stated as a RATIO -- every open window accounted for by the tab strip
      // (one chrome view + one view per tab) -- so it holds however A16
      // resolves: an auto-opened replacement tab is accounted for, a leaked
      // WebContentsView is not.
      //
      // Read ONCE after settling, never polled. `windows === tabs + 1` was
      // ALREADY true before the close (2 windows, 1 tab), so a poll could
      // return without ever observing the close -- and did: a leaked view plus
      // a slightly slower repaint passed this check. Rule 2 in the header.
      await delay(ABSENCE_SETTLE_MS)
      const windowsNow = app.windows().length
      const tabsNow = (await tabIds(chrome)).length
      check(
        'closing the last tab leaves no stray/orphaned window behind',
        windowsNow === tabsNow + 1,
        windowsNow === tabsNow + 1
          ? undefined
          : `${windowsNow} window(s) for ${tabsNow} tab(s), expected ${tabsNow + 1}`
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
      const recovered = await waitFor(async () => (await tabIds(chrome)).length === tabsBeforeRecovery + 1)
      check('the shell recovers: a new tab opens fine after the last one closed', recovered)

      await delay(ABSENCE_SETTLE_MS)
      const windowsAfter = app.windows().length
      const tabsAfter = (await tabIds(chrome)).length
      check(
        'every window is still accounted for by the tab strip after recovering',
        windowsAfter === tabsAfter + 1,
        windowsAfter === tabsAfter + 1
          ? undefined
          : `${windowsAfter} window(s) for ${tabsAfter} tab(s), expected ${tabsAfter + 1}`
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
    // that claim was false -- it passed identically with DNS blackholed, which
    // is how the discrepancy was found. Making it a genuine round-trip test
    // would mean asserting the LOADED PAGE, and would forfeit running offline.
    const SEARCH_QUERY = 'orivon browser smoke check'
    // Built the same way production builds it (omnibox.ts), rather than
    // re-implementing the encoding -- hand-rolled variants diverge on !'()*~
    const expectedSearchUrl = `https://${SEARCH_HOST}/?${new URLSearchParams({ q: SEARCH_QUERY }).toString()}`

    const wantSearch = { address: expectedSearchUrl }
    const search = await navigateTo(SEARCH_QUERY, wantSearch)

    let searchUrl
    try {
      searchUrl = new URL(search.info?.address ?? '')
    } catch {
      searchUrl = undefined
    }

    checkTab('a plain-text address-bar entry resolves to a DuckDuckGo search, not a URL', wantSearch, search)
    const q = searchUrl?.searchParams.get('q')
    check(
      'the DuckDuckGo query carries the exact typed text',
      q === SEARCH_QUERY,
      q === SEARCH_QUERY ? undefined : `q read ${JSON.stringify(q ?? null)}`
    )

    // ---- Dangerous schemes typed into the address bar are refused --------
    // The address bar is chrome-privileged input: a scheme the shell will
    // navigate to here is a sandbox escape or a local-file disclosure one
    // keystroke away (src/main/omnibox.ts's own header; security-model.md
    // T1/T10). parseOmniboxInput is unit tested as a pure function, but
    // nothing exercised the WIRING -- renderer -> IPC ->
    // TabManager.resolveTarget -> loadURL. That gap is the dangerous one: a
    // change adding scheme pass-through in tabs.ts (T23's magnet: handling
    // lands in exactly this code path) keeps every unit test green while
    // re-opening the hole. Confirmed by mutation.
    //
    // TWO THINGS MAKE THIS CHECK REAL, and both were absent from the first
    // version, which passed while /etc/passwd rendered in the tab:
    //
    //   1. The tab is PARKED on a real fixture page before each hostile input,
    //      so the refusal is an observable TRANSITION (fixture -> about:blank)
    //      rather than a state the tab was already in. Rule 2 in the header.
    //   2. After the transition, it SETTLES and reads once, because a refusal
    //      is the absence of a navigation and absence cannot be polled for.
    //      A pass-through deferred by 300ms slipped past the version without
    //      this. Rule 3 in the header.
    //
    // Each case asserts BOTH the shell's view and the tab's own location -- a
    // check that trusted the toolbar alone would be blind to T25 -- and, where
    // a payload could execute without moving `location`, that it did not.
    const HOSTILE_INPUTS = [
      { input: "javascript:document.title='PWNED-JS'", marker: 'PWNED-JS' },
      { input: 'data:text/html,<title>PWNED-DATA</title>', marker: 'PWNED-DATA' },
      { input: 'file:///etc/passwd', marker: undefined },
      // about:blank would be indistinguishable from the fallback, but
      // about:version is not: rejected it lands on about:blank, passed through
      // it commits chrome://version.
      { input: 'about:version', marker: undefined }
    ]

    for (const { input, marker } of HOSTILE_INPUTS) {
      const scheme = input.split(':')[0]

      const parked = await navigateTo(urlFor('/a'), wantA)
      checkTab(`the tab is parked on a real page before typing ${scheme}:`, wantA, parked)

      // Grab the view WHILE it is identifiable by the parked URL. The page
      // object stays valid across the navigation that follows, so the read
      // below is guaranteed to be of the tab that was typed into.
      const view = findViewShowing(app, chrome, urlFor('/a'))
      check(`the parked tab view is identifiable before typing ${scheme}:`, view !== undefined)

      const refused = await navigateTo(input, { address: '' })
      await delay(ABSENCE_SETTLE_MS)
      const seen = await readTabDocument(view)
      const landedSafe = refused.ok && seen?.href === 'about:blank'

      check(
        `the address bar refuses ${scheme}: and falls back to the new-tab page`,
        landedSafe,
        landedSafe
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
  }

  // REPORT BEFORE TEARDOWN. app.close() can throw -- most plausibly when the
  // app has already died, which is the scenario the last-tab checks exercise
  // -- and a throw there would discard everything collected above.
  console.log(JSON.stringify(result, null, 2))
  if (failures.length > 0) {
    console.error('\nSmoke check FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
  }

  try {
    await app.close()
  } catch (e) {
    console.error('teardown: app.close() failed (results above still stand):', String(e).split('\n')[0])
  }
  server.close()

  if (failures.length > 0) process.exit(1)
  console.log('\nSmoke check passed.')
}

main().catch((e) => {
  console.error('Smoke check crashed before it could report:', e)
  process.exit(1)
})
