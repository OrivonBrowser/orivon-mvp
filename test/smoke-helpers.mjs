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

/** Every popup shell/popover-view.ts builds, by its own renderer entry --
 * never a real tab, so `tabViews()` below must never count one as one. A
 * `warm` popup (the main menu) is the reason this exclusion is needed at
 * all: its webContents can outlive being closed (popoverShown's own doc), so
 * `app.windows()` keeps listing it long after a script that opened and
 * closed it would otherwise expect the "just the tabs" count to settle back
 * down. */
const POPOVER_URL_PARTS = ['/menu/', '/permissions/', '/site-info/']

/** Non-chrome, non-popover views, as Playwright pages -- lets a check read a
 * tab's OWN location rather than trusting the toolbar's rendering of it
 * (T25: the address bar is a display layer and can lie independently). */
export function tabViews (app, chrome) {
  return app.windows().filter((w) => w !== chrome && !POPOVER_URL_PARTS.some((part) => w.url().includes(part)))
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
 *
 * NEVER CALL `window.orivon.*` FROM `fn` HERE. Measured live: a stack
 * captured inside a plain `page.evaluate()` call has no fileName at any
 * frame, all the way down through Playwright's own internal `eval` --
 * and neither does a `<script>` element created with `document.
 * createElement`/`appendChild` and no `src`, which Chromium attributes
 * `<anonymous>` regardless. src/preload/surface/main-world-socket.ts's own
 * extension-code check (that file's README.md Design notes) refuses such a
 * call as unattributable, correctly. Only a literal `<script>` PRESENT IN
 * THE SERVED HTML -- parser-inserted, the same as the page's own -- is
 * attributed to the document's URL (`extension-stack-probe.json`'s own
 * `mainWorld` entries; scripts/smoke.mjs's `/orivon-probe` fixture route is
 * the worked example): the calling code has to be literal HTML a real
 * server serves, which only the caller's own fixture can supply.
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

/**
 * Whether the popover whose URL contains `urlPart` (e.g. `/menu/`) is
 * currently attached to the screen. NOT the same question as "does its
 * webContents exist" -- a `warm` popover (shell/popover-view.ts, the main
 * menu) keeps its webContents alive while hidden rather than destroying it,
 * so `app.windows()` still lists it long after it closed. Reads the e2e-only
 * hook (shell/view-background-test-hook.ts's `recordPopoverShown`), present
 * only in a dev-grant-enabled build (`npm run test:e2e`'s own build step).
 */
export async function popoverShown (app, urlPart) {
  return await app.evaluate(({ webContents }, part) => {
    const target = webContents.getAllWebContents().find((wc) => wc.getURL().includes(part))
    if (target === undefined) return false
    const shown = globalThis.__orivonDevPopoverShown
    return shown !== undefined && shown.has(target.id)
  }, urlPart)
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
/** Whether the bookmarks bar is drawn AND main sized the chrome view to
 * hold it -- asserted as one fact because either half alone passes while
 * the feature is broken: a row drawn into a view main never grew is
 * clipped, and a view grown for a row the CSS never drew is a band of
 * empty chrome. Read from the page, never from main's internals, since
 * the disagreement between the two is the bug worth catching.
 * `shown` false is the mirror image: no row, and no space kept for one. */
export async function bookmarksBarMatches (chrome, shown) {
  const g = await evaluateRetrying(chrome, () => ({
    viewHeight: window.innerHeight,
    barHeight: document.querySelector('.bookmarksbar')?.getBoundingClientRect().height ?? 0
  }))
  return shown ? g.barHeight === 28 && g.viewHeight === 104 : g.barHeight === 0 && g.viewHeight === 76
}

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

/**
 * Presses `key` on `selector` inside `view` to trigger a same-tab navigation
 * that is expected to DESTROY `view` itself, then returns whether the
 * chrome's own address bar reached `expectedAddress` and the tab's CURRENT
 * view (a new Playwright object, or undefined if none is open).
 *
 * The dashboard's search box (src/renderer/newtab/main.ts) is the one place
 * in this app where an input lives INSIDE a tab's own content view rather
 * than the persistent chrome view -- so pressing Enter there triggers a
 * chain that tears down the very view Playwright is mid-command against:
 * the 'submit' handler calls shell.navigate() (a fire-and-forget IPC send,
 * preload/newtab.ts), newtab-ipc.ts's handler calls TabManager.navigate(),
 * and since the dashboard's partition is always undefined while any real
 * http(s) target gets a real one (src/main/tabs.ts), that always
 * repartitions -- closing this view and swapping in a new one -- before
 * Playwright's own press() finishes its round trip against the page it
 * just closed. Confirmed by a standalone probe (not kept in this repo)
 * that the navigation itself completes correctly regardless: the chrome's
 * address bar updates, the new view loads the right page, nothing leaks.
 * That makes the "Target ... closed" error a Playwright/CDP artifact of
 * driving a self-navigating page through its own view, not a product bug
 * -- expected and swallowed here. Any OTHER error still propagates.
 */
export async function navigateThroughSelfDestroyingView (app, chrome, view, selector, key, expectedAddress) {
  await view.press(selector, key).catch((e) => {
    if (!/Target page, context or browser has been closed/.test(String(e))) throw e
  })
  const navigated = await waitFor(async () => {
    const info = await evaluateRetrying(chrome, () => ({ address: document.querySelector('#address')?.value }))
    return info.address === expectedAddress
  })
  const [current] = tabViews(app, chrome)
  return { navigated, view: current }
}

/** Compact "wanted X, saw Y" for a failed check's detail field. */
export function mismatch (expected, info) {
  const seen = Object.fromEntries(Object.keys(expected).map((field) => [field, info?.[field]]))
  return `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`
}
