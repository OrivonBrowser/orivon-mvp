// Makes the chrome page of a window that is still hidden paint, so `ready-to-show` comes from a real first paint.
// Tied to Electron: it drives a `webContents.debugger`. The rule for when a window waits is window-frame.ts's;
// DESIGN.md says why a debugger, and why an end-to-end run does not hold.
import type { WebContents } from 'electron'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** The part of a `WebContents` this needs: `debugger` and whether the page is gone. */
export type PaintTarget = Pick<WebContents, 'isDestroyed'> & { readonly debugger: Pick<WebContents['debugger'], 'attach' | 'detach' | 'sendCommand'> }

const FOCUS_EMULATION = 'Emulation.setFocusEmulationEnabled'

/** Test builds only: an end-to-end run's driver already makes every page visible with the same emulation, and the
 * emulation is one flag with no owner, so ending a hold would switch the driver's off. Set by the test launcher
 * (test/support/launch-electron.mjs); an ordinary build carries none of this (scripts/check-dev-grant-absent.mjs). */
function heldOffByTest (env: Readonly<Record<string, string | undefined>>): boolean {
  return SEAM_ENABLED && env['ORIVON_TEST_NO_PAINT_HOLD'] === '1'
}

/** Starts the hold and returns the way to end it, which may be called any number of times and does its work once. A
 * page whose debugger another client holds is left as it was: window-frame.ts's timer shows the window then if nothing
 * paints it. */
export function paintWhileHidden (contents: PaintTarget, env: Readonly<Record<string, string | undefined>> = process.env): () => void {
  if (heldOffByTest(env)) return () => {}
  try {
    contents.debugger.attach('1.3')
  } catch {
    return () => {}
  }
  // A rejected command (the page went away) leaves nothing to undo; the process ends on an unhandled rejection.
  void contents.debugger.sendCommand(FOCUS_EMULATION, { enabled: true }).catch(() => {})
  let held = true
  return () => {
    if (!held) return
    held = false
    if (contents.isDestroyed()) return
    void contents.debugger.sendCommand(FOCUS_EMULATION, { enabled: false })
      .catch(() => {})
      .finally(() => { try { contents.debugger.detach() } catch { /* the page went away */ } })
  }
}
