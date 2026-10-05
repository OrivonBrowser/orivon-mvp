// Owner request: a build/test launch must not steal OS keyboard focus while
// the owner is typing elsewhere on the same machine. src/main/window.ts's
// showOnce() picks win.showInactive() over win.show() when
// ORIVON_WINDOW_NO_FOCUS=1 -- launch-electron.mjs defaults that on for
// every launch made through it, which is the actual fix here: a test run
// cannot forget to opt in.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It launches a real Electron process
// and reads its own main-process console output, so it proves the real
// showOnce() branch that ran, not a mock and not just the condition in
// isolation. It CANNOT prove real OS focus behaviour: under a virtual
// display there is no window manager to take focus FROM, so
// win.isFocused() would read the same regardless of which branch ran.
// That half is not machine-checkable here, by design -- see this repo's PR
// for what was and was not verified.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './support/launch-electron.mjs'
import { delay, HERMETIC_RESOLVER, waitFor } from './support/smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const NO_FOCUS_MARKER = '[window] ORIVON_WINDOW_NO_FOCUS=1 -- showInactive()'

/** showOnce's hard fallback (src/main/window.ts) fires 1000ms after launch
 * if 'ready-to-show' has not already -- long enough that the negative case
 * below waits past it before reading mainOutput() once. */
const SHOW_FALLBACK_MS = 1_000

const TEST_TIMEOUT_MS = 30_000

it('showOnce takes the showInactive() branch under the default test launch (ORIVON_WINDOW_NO_FOCUS=1)', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await waitFor(() => mainOutput(app).includes(NO_FOCUS_MARKER))
    expect(mainOutput(app)).toContain(NO_FOCUS_MARKER)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('showOnce falls back to the ordinary show() when the switch is explicitly off, proving the branch is conditional', async () => {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_WINDOW_NO_FOCUS: '0' }
  })
  try {
    // Absence cannot be polled for (scripts/smoke.mjs's own rule 3) -- wait
    // out the window the marker could have appeared in, then read once.
    await delay(SHOW_FALLBACK_MS + 500)
    expect(mainOutput(app)).not.toContain(NO_FOCUS_MARKER)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// window-options.ts's own doc: ORIVON_WINDOW_NO_FOCUS=1 may leave unfocused
// ONLY the launch's own first window (index.ts's two call sites pass
// `firstOfLaunch: true` there and nowhere else) -- a window opened
// afterward always takes the ordinary show() branch, so an unattended test
// or dev run that opens a second window does not silently mask a real
// focus-stealing bug in whatever opened it.
it('a second window always takes the ordinary show() branch, even under the same launch\'s ORIVON_WINDOW_NO_FOCUS=1', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await waitFor(() => mainOutput(app).includes(NO_FOCUS_MARKER))
    const beforeCount = mainOutput(app).split(NO_FOCUS_MARKER).length - 1
    expect(beforeCount).toBe(1) // the launch's own first window, and only it

    const chrome = app.windows().find((w) => w.url().endsWith('/renderer/index.html'))
    if (chrome === undefined) throw new Error('no chrome window to open a second one from')
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
    await waitFor(() => app.windows().filter((w) => w.url().endsWith('/renderer/index.html')).length === 2)

    // Absence cannot be polled for -- the fallback timer is the longest
    // this window could still take to show, so waiting it out and reading
    // once is what proves the marker never appears a second time.
    await delay(SHOW_FALLBACK_MS + 500)
    expect(mainOutput(app).split(NO_FOCUS_MARKER).length - 1).toBe(beforeCount)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
