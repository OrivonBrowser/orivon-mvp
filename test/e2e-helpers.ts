// Shared harness for the capability end-to-end tests: the fixture-server child
// handling, the address-bar navigation dance, and the per-phase reporter.
//
// Extracted from ./e2e-capability-boundary.test.ts when
// ./e2e-udp-capability.test.ts needed all of it verbatim. The REASON is shared
// -- drive the real shell to a real page and report per phase -- not merely the
// shape (code-guidelines.md Rule 3). A PURE MOVE: no behaviour changed, so the
// diff reads as one.
//
// Not a *.test.ts, so no vitest config collects it as its own suite -- same
// precedent as src/broker/tests/index.test-helpers.ts.

import { expect } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import type { ElectronApplication } from 'playwright'
import { closeElectron, APP_CLOSE_RACE_MS } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, waitFor, waitForTab } from './smoke-helpers.mjs'
import { BUILTIN_ADDRESSES } from '../src/protocols/builtin.js'
/** Ceiling for waitForAddressBarStable below. Named so the budget
 * arithmetic beneath it can reuse the real number instead of retyping
 * `8_000` in two places that could quietly drift apart. */
export const ADDRESS_BAR_STABLE_TIMEOUT_MS = 8_000

/** Re-exported so every e2e file can import the app-close race ceiling from
 * here alongside the rest of this shared harness, without also reaching
 * into launch-electron.mjs directly -- the canonical value lives there now
 * (launchElectron and closeElectron are the same module), see its own doc
 * comment. */
export { APP_CLOSE_RACE_MS }

/** Forwards a fixture server child's stdout/stderr, prefixed -- mirrors
 * launch-electron.mjs's own reasoning for the Electron process: Node
 * swallows a child's output by default, and a server that failed to bind
 * (e.g. a leftover process still holding the port from a prior run) must
 * not fail this test silently. */
export function forwardOutput (label: string, child: ChildProcess): void {
  child.stdout?.on('data', (d: Buffer) => { process.stderr.write(`[${label}] ${d}`) })
  child.stderr?.on('data', (d: Buffer) => { process.stderr.write(`[${label}] ${d}`) })
}

/** Polls a real TCP connect until it succeeds, per testing.md's own rule
 * (also scripts/smoke.mjs's rule 2): wait for the condition, never a fixed
 * sleep -- a fixture server binding its port is exactly that kind of
 * condition, and a sleep long enough to be safe on a loaded CI box is a
 * needless tax on every fast local run. */
export async function waitForTcpReady (host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host, port }, () => { socket.end(); resolve(true) })
      socket.once('error', () => { resolve(false) })
    })
    if (ok) return
    if (Date.now() >= deadline) {
      throw new Error(`nothing accepted a connection on ${host}:${port} within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Kills a child and waits for it to actually exit, escalating to SIGKILL --
 * an orphaned echo-server/serve.mjs process would hold ECHO_PORT/STATIC_PORT
 * for the NEXT run of this file, turning a clean re-run into a confusing
 * "port already in use" failure that has nothing to do with the test. */
export async function killChild (child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const onExit = (): void => resolve()
    child.once('exit', onExit)
    child.kill('SIGTERM')
    setTimeout(() => { child.kill('SIGKILL') }, 2_000).unref()
  })
}
/** How many consecutive equal reads of `#address`'s bounding box count as
 * "stopped moving". Two agreeing reads is enough for the documented cause
 * below (a single discrete relayout, not a continuous transition) -- three
 * costs one extra 50ms poll (smoke-helpers.mjs's own POLL_INTERVAL_MS) and
 * buys a little margin against a slow, continuous motion that could
 * otherwise land on the same sampled value twice in a row. It is NOT a
 * general animation-detection guarantee: a continuous transition slow
 * enough to hold one value for two full poll intervals would still pass.
 * If that ever becomes the actual failure mode, that is the point to
 * either require reads separated by a minimum interval or read a CSS
 * transition/animation state directly instead of raising this number
 * further. */
export const STABLE_READS_REQUIRED = 3

/**
 * Waits until `#address`'s own bounding box reads the same
 * STABLE_READS_REQUIRED times in a row, or the deadline passes.
 *
 * A plain `.click()` already retries its own "is this element stable" check
 * internally for up to DEFAULT_ACTION_TIMEOUT_MS (launch-electron.mjs) --
 * but that check runs invisibly inside `.click()`, and on a slower CI
 * runner it has been observed to spend the whole ten seconds there: right
 * after `app.windows().length === 2` first holds, the chrome window's
 * WebContentsView can still be mid-layout (src/main/window.ts's resize
 * handler re-runs layoutChrome()/tabs.layout() on a setImmediate deferral,
 * and the omnibox is a flex child of that view's width), which keeps
 * moving `#address` under Playwright's own stability check for reasons
 * that have nothing to do with whether the click itself would work. Naming
 * the same condition explicitly, with this file's own evaluateRetrying/
 * waitFor -- the exact composition smoke-helpers.mjs's waitForTab already
 * uses for a different condition, not a new waiting mechanism -- gives
 * that settling somewhere to happen before the click is attempted, so the
 * click's own ten seconds are spent on the click. Each read waits for an
 * animation frame, so "stable" also means the page is painting.
 */
export async function waitForAddressBarStable (
  page: ReturnType<typeof findChrome>,
  timeoutMs = ADDRESS_BAR_STABLE_TIMEOUT_MS
): Promise<boolean> {
  let previous: string | null = null
  let streak = 0
  return waitFor(async () => {
    // Read inside an animation frame. Playwright's own "stable" check counts
    // animation frames, so a window that has not painted one yet (a cold first
    // launch, a view not yet shown) passes every bounding-box read and still
    // leaves `.click()` waiting its whole ten seconds for a frame. A read
    // that gets no frame within half a second counts as not stable.
    const rect = await evaluateRetrying(page, () => new Promise<string | null>((resolve) => {
      const el = document.querySelector('#address')
      if (el === null) { resolve(null); return }
      const noFrame = setTimeout(() => { resolve(null) }, 500)
      requestAnimationFrame(() => {
        clearTimeout(noFrame)
        const r = el.getBoundingClientRect()
        resolve(`${r.x},${r.y},${r.width},${r.height}`)
      })
    }))
    streak = (rect !== null && rect === previous) ? streak + 1 : 0
    previous = rect
    return streak >= STABLE_READS_REQUIRED - 1
  }, timeoutMs)
}

/**
 * Runs the address-bar navigation (click, fill, press Enter), retrying
 * ONCE if the first attempt fails with the exact known-flaky signature
 * (`docs/open-questions.md` C6): `waitForAddressBarStable` above already
 * reported the bounding box stopped moving, but Playwright's own
 * actionability wait on `.click()` -- which checks more than position, most
 * likely hit-testability against the compositor's actual paint state -- can
 * still time out on a loaded CI runner a frame or two behind a layout that
 * has already stopped moving. Bounding-box stability proves position
 * stopped changing; it does not prove the compositor caught up to it.
 *
 * A single explicit retry, never a loop: this is a mitigation for a
 * documented environment race, not a general-purpose retry-until-it-passes.
 * Two consecutive failures on the exact same element are far more likely to
 * be a real regression than CI-runner timing, and this must not paper over
 * that -- the second attempt's error propagates unchanged.
 *
 * Matches on the timeout's own message rather than catching everything,
 * so an unrelated failure from `.fill()`/`.press()` (a real bug) still
 * fails immediately rather than being masked by a pointless retry.
 */
export async function clickAddressBarRetrying (page: ReturnType<typeof findChrome>, url: string): Promise<void> {
  try {
    await page.click('#address')
  } catch (error) {
    const isKnownFlake = error instanceof Error && error.message.includes('Timeout') && error.message.includes("locator('#address')")
    if (!isKnownFlake) throw error
    await waitForAddressBarStable(page)
    await page.click('#address')
  }
  await page.fill('#address', url)
  await page.press('#address', 'Enter')
}

/**
 * Runs one phase's checks into its own `checks`/`failures` lists and its
 * own `expect`, so Phase 1 and Phase 2 below report as fully independent
 * `it()` results -- scripts/smoke.mjs's own rule 1 ("it reports, it does
 * not just exit"), applied per phase rather than once for the whole file.
 */
export async function runPhase (
  phaseLabel: string,
  run: (check: (name: string, pass: boolean, detail?: string) => void) => Promise<void>
): Promise<void> {
  const checks: Array<{ name: string, pass: boolean, detail?: string }> = []
  const failures: string[] = []
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, pass } : { name, pass, detail })
    if (!pass) failures.push(detail === undefined ? name : `${name} -- ${detail}`)
  }

  await run(check)

  console.log(JSON.stringify({ phase: phaseLabel, checks }, null, 2))
  if (failures.length > 0) {
    console.error(`\n${phaseLabel} FAILED:`)
    for (const f of failures) console.error(`  - ${f}`)
  } else {
    console.log(`\n${phaseLabel} passed.`)
  }

  expect(failures).toEqual([])
}

/**
 * Launches the real shell, navigates its default tab to `url`, and returns
 * the fixture tab's own Playwright page -- the mechanics every capability
 * e2e test's Phase 1 already runs, with one `check()` per step, because
 * that phase's whole point is proving the UI mechanics themselves work. A
 * grant test's own real-page phase does not need that granularity a second
 * time: it needs a page under a real grant, reliably, so a failure here
 * surfaces as an ordinary thrown error into the calling phase's own
 * try/catch instead of a named check.
 */
/**
 * Waits until the fixture page's script has defined `name` on its global.
 * The page's title is parsed before a `<script src>` in its head has run, so
 * a tab showing the right title may not have that global yet.
 */
export async function waitForPageGlobal (view: ReturnType<typeof findChrome>, name: string, timeoutMs = 30_000): Promise<void> {
  await view.waitForFunction((global: string) => (globalThis as Record<string, unknown>)[global] !== undefined, name, { timeout: timeoutMs })
}

let asPageCounter = 0

/**
 * Runs `fn` as a script the PAGE itself loaded (a real `<script src>` at a
 * same-origin http(s) URL), never through Playwright's own `page.evaluate()`
 * -- which leaves no page frame at all, so main-world-socket.ts's caller-
 * attribution filter refuses every `window.orivon` call made that way
 * (ADR-0045; that file's own README.md Design notes). Generalises
 * test/e2e-extensions-orivon-filter.test.ts's own PAGE_JS/page.js: `serve`
 * must be a fixture server's own hook that makes GETting `scriptUrl` (on
 * the SAME origin `view` is currently showing) return whatever text this
 * call last gave it -- the individual fixture servers differ too much to
 * share one HTTP implementation, so only the calling convention is shared
 * here.
 *
 * `fn` is SERIALISED (`Function.prototype.toString()`) and re-evaluated
 * fresh in the page: it may use `window.orivon` (or any other page global)
 * freely, but -- exactly `installOrivon`'s own constraint
 * (src/preload/surface/main-world-socket.ts's header) -- it must close over
 * nothing outside its own body: no free variables, no imports. Arguments
 * must be JSON-serialisable. Whatever `fn` returns (or throws) crosses back
 * through a page-global this helper polls for, never through a Playwright
 * return value.
 */
export async function asPage<T> (
  view: ReturnType<typeof findChrome>,
  serve: (js: string) => void,
  scriptUrl: string,
  fn: (...args: never[]) => T | Promise<T>,
  ...args: readonly unknown[]
): Promise<T> {
  const marker = `__orivonAsPage${asPageCounter++}`
  serve(`(async () => {
    try {
      const fn = (${fn.toString()})
      const result = await fn(${args.map((a) => JSON.stringify(a)).join(', ')})
      window['${marker}'] = { ok: true, result }
    } catch (error) {
      window['${marker}'] = {
        ok: false,
        name: error && typeof error === 'object' ? error.name : undefined,
        message: error && typeof error === 'object' ? error.message : String(error),
        code: error && typeof error === 'object' ? error.code : undefined
      }
    }
  })()`)
  await view.evaluate(({ url, marker }: { url: string, marker: string }) => {
    const script = document.createElement('script')
    script.src = url + (url.includes('?') ? '&' : '?') + 'asPage=' + encodeURIComponent(marker)
    document.head.appendChild(script)
  }, { url: scriptUrl, marker })
  await view.waitForFunction((m: string) => (window as unknown as Record<string, unknown>)[m] !== undefined, marker, { timeout: 30_000 })
  const outcome = await view.evaluate((m: string) => (window as unknown as Record<string, unknown>)[m], marker) as
    { ok: true, result: T } | { ok: false, name?: string, message?: string, code?: string }
  if (!outcome.ok) {
    const error = new Error(outcome.message ?? 'asPage: the page script threw') as Error & { code?: string }
    if (outcome.name !== undefined) error.name = outcome.name
    if (outcome.code !== undefined) error.code = outcome.code
    throw error
  }
  return outcome.result
}

export async function navigateToFixture (
  app: ElectronApplication,
  url: string,
  expectedTitle: string
): Promise<ReturnType<typeof findChrome>> {
  await waitFor(() => app.windows().length === 2)
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  await clickAddressBarRetrying(chrome, url)
  const shown = BUILTIN_ADDRESSES.displayUrl(url)
  const navigated = await waitForTab(chrome, { address: shown, title: expectedTitle })
  if (!navigated.ok) throw new Error(`fixture tab did not navigate to ${shown}: ${JSON.stringify(navigated.info)}`)
  const view = findViewShowing(app, chrome, url)
  if (view === undefined) throw new Error(`no view found showing ${url}`)
  return view
}

/**
 * The toolbar's Web3 Score shield level and its Web2/Web2.5/Web3 mark ('' while
 * hidden), read once `web3ScoreFor` has answered. src/renderer/main.ts clears
 * both when the active origin changes and paints the answer when it lands, so a
 * read straight after navigating can catch the cleared state.
 */
export async function readShield (chrome: ReturnType<typeof findChrome>): Promise<{ level: string | null, mark: string }> {
  const painted = await waitFor(async () => await chrome.evaluate(() => document.querySelector('#web3-score-btn .web3-shield')?.hasAttribute('data-level') === true), 8_000)
  if (!painted) throw new Error('the toolbar shield never painted a level')
  return await chrome.evaluate(() => {
    const mark = document.querySelector<HTMLElement>('#web3-mark')
    return {
      level: document.querySelector('#web3-score-btn .web3-shield')?.getAttribute('data-level') ?? null,
      mark: mark === null || mark.hidden ? '' : mark.textContent ?? ''
    }
  })
}

/**
 * Closes every tab (a real click, the same one a person would use), waits
 * for the shell to reach zero windows, then hands off to closeElectron()
 * for the part that must never depend on this succeeding: the bounded
 * `app.close()` race, an unconditional SIGKILL of whatever is left of the
 * process tree, and always removing the launch's `--user-data-dir` temp
 * profile, whether this function's own steps above threw or not
 * (closeElectron's own `beforeClose` runs inside a try/catch for exactly
 * that reason).
 *
 * WHY THE TAB-CLOSING DANCE, SPECIFICALLY: `_electron`'s `app.close()` hangs
 * INDEFINITELY while any tab remains open (found by direct instrumented
 * reproduction, not the documented C6 attach issue -- a different symptom
 * of the same driver class; reproduced down to a launch with zero
 * navigation). Closing every tab first fires src/main/index.ts's
 * window-all-closed -> app.quit(), which makes app.close() resolve in
 * ~100ms instead. This is a real, hard-won workaround for THIS shell's own
 * behaviour -- closeElectron's own SIGKILL fallback is the last-resort net
 * for a future regression in the tab-closing step itself (a selector
 * rename, say), so that degrades to a slow, reported failure, never a
 * second silent hang.
 */
export async function closeElectronApp (app: ElectronApplication, raceMs = APP_CLOSE_RACE_MS): Promise<void> {
  await closeElectron(app, {
    raceMs,
    // Ignores the callback's own (deliberately minimal, see TeardownApp's
    // own header in launch-electron.mjs) parameter and closes over `app`
    // directly instead -- it is the same object, typed here as the real
    // ElectronApplication this function's own signature already requires.
    beforeClose: async () => {
      const chrome = app.windows().find((w) => w.url().endsWith('/renderer/index.html'))
      if (chrome !== undefined) {
        const ids: string[] = await evaluateRetrying(chrome, () =>
          Array.from(document.querySelectorAll('.tab')).map((el) => (el as HTMLElement).dataset.id ?? '')
        ).catch(() => [])
        for (const id of ids) {
          await chrome.click(`[data-id="${id}"] .close`).catch(() => {})
        }
      }
      await waitFor(() => app.windows().length === 0)
    }
  })
}


/** Presses a key on the webContents whose URL contains `urlPart`, through the
 * browser process, the way a key from the keyboard arrives. Playwright's own
 * `keyboard` goes straight to the renderer and never reaches the browser's
 * shortcut handling. `keyCode` is Electron's name for the key ('T', 'Tab', 'F5'). */
export async function pressKey (app: ElectronApplication, urlPart: string, keyCode: string, modifiers: string[] = []): Promise<void> {
  await app.evaluate(({ webContents }, [part, code, mods]) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL().includes(part as string))
    if (target === undefined) throw new Error(`no webContents at ${part as string}`)
    const events = [{ type: 'keyDown' }, { type: 'keyUp' }] as const
    for (const { type } of events) target.sendInputEvent({ type, keyCode: code as string, modifiers: mods as Array<'control'> })
  }, [urlPart, keyCode, modifiers] as const)
}
