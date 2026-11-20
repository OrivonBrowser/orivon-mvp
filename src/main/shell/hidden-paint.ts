// Makes the chrome page of a window that is still hidden paint, so `ready-to-show` comes from a real first paint.
// Tied to Electron: it drives a `webContents.debugger`. The rule for when a window waits is window-frame.ts's;
// DESIGN.md says why a debugger, and why a browser driven over a debugging connection does not hold.
import type { CommandLine, WebContents } from 'electron'

/** The part of a `WebContents` this needs: `debugger` and whether the page is gone. */
export type PaintTarget = Pick<WebContents, 'isDestroyed'> & { readonly debugger: Pick<WebContents['debugger'], 'attach' | 'detach' | 'sendCommand'> }

/** The command-line switches that open the browser to a debugging client (Playwright and Puppeteer use the first). */
const DEBUGGING_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe']

const FOCUS_EMULATION = 'Emulation.setFocusEmulationEnabled'

/** Starts the hold and returns the way to end it, which may be called any number of times and does its work once. A
 * browser started with a debugging switch is left as it was, its client making the page visible; so is a page whose
 * debugger another client holds: window-frame.ts's timer shows the window then if nothing paints it. */
export function paintWhileHidden (contents: PaintTarget, commandLine: Pick<CommandLine, 'hasSwitch'>): () => void {
  if (DEBUGGING_SWITCHES.some((name) => commandLine.hasSwitch(name))) return () => {}
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
