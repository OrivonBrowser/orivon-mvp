// Shared plumbing for scripts/smoke.mjs: launch config, waiting/polling,
// and reading the chrome view's own rendered state. Split out 2026-08-28
// (code-guidelines.md Rule 2) when the chrome restyle's bookmark
// scenarios would have pushed smoke.mjs past its 800-line test-file
// ceiling -- this is helpers, smoke.mjs is scenarios.
//
// Read scripts/smoke.mjs's header before changing anything here: the
// three rules it states (report, don't just exit; never wait for a
// condition already true; absence cannot be polled for) are why several
// of these functions are shaped the way they are.

/**
 * Nothing resolves except loopback. Deliberately a whole-world blackhole
 * rather than `MAP duckduckgo.com ~NOTFOUND`: the property being protected is
 * "this run cannot reach the network", and a per-host rule only protects the
 * one host someone thought of. Verified: the full suite passes under this.
 */
export const HERMETIC_RESOLVER = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'

/** Ceiling on waitFor(). Every state push in this shell lands in
 * milliseconds; this only bounds the broken case, where the caller's own
 * check() then fails by name. */
export const WAIT_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 50

/**
 * How long to wait before concluding a navigation did NOT happen (rule 3).
 * Must comfortably exceed the time between `loadURL` being called and the
 * navigation committing. A deferred pass-through of only 300ms was enough to
 * slip past an earlier version of the deny-path checks.
 */
export const ABSENCE_SETTLE_MS = 1_500

/** BUG (found 2026-08-28, real regression): `.endsWith('index.html')` was
 * unique before the new-tab dashboard existed -- no tab could ever end
 * in `index.html`. The dashboard's own URL (`.../newtab/index.html`)
 * ALSO passes that check, so this could match either window depending
 * on commit-order timing, silently driving the whole rest of the script
 * against the wrong page (every subsequent action degrades to a full
 * per-step timeout instead of throwing, compounding into several
 * minutes of total silence). Matched against the FULL renderer path so
 * the dashboard's nested one can never qualify. */
export function findChrome (app) {
  const win = app.windows().find((w) => w.url().endsWith('/renderer/index.html'))
  if (win === undefined) throw new Error('chrome view not found in app.windows()')
  return win
}

/** Non-chrome views, as Playwright pages -- lets a check read a tab's OWN
 * location rather than trusting the toolbar's rendering of it (T25: the
 * address bar is a display layer and can lie independently). */
export function tabViews (app, chrome) {
  return app.windows().filter((w) => w !== chrome)
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Polls until `predicate` is true, or the ceiling is hit. Returns the outcome
 * as a boolean so the caller's own check() reports it by name.
 *
 * Read scripts/smoke.mjs's header rule 2 before using this. It is the right
 * tool for "the app should reach state X", and the wrong tool for "the app
 * should stay in state X" or "X should not happen".
 */
export async function waitFor (predicate, timeoutMs = WAIT_TIMEOUT_MS) {
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
 *
 * BUG (found 2026-08-28): `page.evaluate()` itself has NO timeout in this
 * Playwright version (confirmed against the installed source -- it passes
 * `kNoTimeout` internally). The `timeoutMs` deadline here was only ever
 * consulted inside the `catch` block, so a call that never settles at all
 * (an execution-context race that doesn't resolve either way, rather than
 * throwing) was never bounded by it -- silently contradicting this file's
 * own "it reports, it does not just exit" rule (scripts/smoke.mjs's
 * header). Racing the evaluate itself against the deadline is what
 * actually enforces it.
 */
export async function evaluateRetrying (page, fn, timeoutMs = WAIT_TIMEOUT_MS) {
  const TRANSIENT = /Execution context was destroyed|frame was detached/i
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now())
    try {
      return await Promise.race([
        page.evaluate(fn),
        delay(remaining).then(() => {
          throw new Error(`evaluateRetrying: page.evaluate() did not settle within ${timeoutMs}ms`)
        })
      ])
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
export function findViewShowing (app, chrome, url) {
  return tabViews(app, chrome).find((w) => w.url() === url)
}

/** ONE read of a tab view's own location and title. Deliberately not a poll --
 * a caller asserting an absence must settle first, then read once (rule 3). */
export async function readTabDocument (view) {
  if (view === undefined) return undefined
  return evaluateRetrying(view, () => ({ href: location.href, title: document.title }))
}

export async function activeTabInfo (chrome) {
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
      address: document.querySelector('#address')?.value,
      // Chrome restyle, 2026-08-28: whether the bookmark toggle shows the
      // active tab's URL as bookmarked (main.ts's renderToolbar()).
      bookmarked: document.querySelector('#bookmark-toggle')?.classList.contains('active')
    }
  })
}

/** Tab ids currently rendered in the tab strip, in strip order. */
export async function tabIds (chrome) {
  return evaluateRetrying(chrome, () =>
    Array.from(document.querySelectorAll('.tab')).map((el) => el.dataset.id)
  )
}

/** Bookmark URLs currently rendered in the bookmarks bar, in list order. */
export async function bookmarkUrls (chrome) {
  return evaluateRetrying(chrome, () =>
    Array.from(document.querySelectorAll('#bookmarks-list .bmitem')).map((el) => el.title)
  )
}

/** The active tab's favicon `<img src>`, or null if the slot is
 * currently showing the SVG fallback (globe/spinner) or the new-tab
 * badge instead -- src/renderer/main.ts's renderFavicon() only ever
 * renders one of an <img>, an <svg>, or plain text at a time. */
export async function activeTabFaviconSrc (chrome) {
  return evaluateRetrying(chrome, () =>
    document.querySelector('.tab.active .fav img')?.getAttribute('src') ?? null
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
export async function waitForTab (chrome, expected) {
  let info
  const ok = await waitFor(async () => {
    info = await activeTabInfo(chrome)
    return Object.entries(expected).every(([field, value]) => info[field] === value)
  })
  return { ok, info }
}

/** Compact "wanted X, saw Y" for a failed check's detail field. */
export function mismatch (expected, info) {
  const seen = Object.fromEntries(Object.keys(expected).map((field) => [field, info?.[field]]))
  return `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`
}
