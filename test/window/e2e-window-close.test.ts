// A window with two or more tabs used to take the whole process down when it
// closed: the window was destroyed first, and each tab's `destroyed` event
// then asked it for its bounds. Every other suite closes its tabs before it
// quits, so none of them walks this path.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 40_000
const EXIT_WAIT_MS = 15_000

it('closing the window with two tabs open exits cleanly', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await chrome.click('#new-tab')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)

    const exit = new Promise<number | null>((resolve) => {
      app.process().once('exit', (code) => { resolve(code) })
    })
    // Not awaited: the window closing takes this call's own target with it.
    void app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.close() }).catch(() => {})

    // macOS keeps the app resident when its last window closes (src/main/index.ts, window-all-closed); the
    // process ends only on an explicit quit.
    if (process.platform === 'darwin') {
      expect(await waitFor(async () => (await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)) === 0)).toBe(true)
      expect(app.process().exitCode).toBeNull()
      void app.evaluate(({ app: electronApp }) => { electronApp.quit() }).catch(() => {})
    }
    const outcome = await Promise.race([exit, delay(EXIT_WAIT_MS).then(() => 'still running' as const)])

    expect(mainOutput(app)).not.toContain('uncaught exception')
    expect(outcome).toBe(0)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
