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
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { delay, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const NO_FOCUS_MARKER = '[window] ORIVON_WINDOW_NO_FOCUS=1 -- showInactive()'

/** showOnce's hard fallback (src/main/window.ts) fires 1000ms after launch
 * if 'ready-to-show' has not already -- long enough that the negative case
 * below waits past it before reading mainOutput() once. */
const SHOW_FALLBACK_MS = 1_000

const TEST_TIMEOUT_MS = 30_000

it('showOnce takes the showInactive() branch under the default test/smoke launch (ORIVON_WINDOW_NO_FOCUS=1)', async () => {
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
