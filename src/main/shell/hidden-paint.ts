// Makes the chrome page of a window that is still hidden paint, so `ready-to-show` comes from a real first paint.
// Tied to Electron: it drives a `webContents.debugger`. The rule for when a window waits is window-frame.ts's;
// DESIGN.md says why a debugger.
import type { WebContents } from 'electron'

/** The part of a `WebContents` this needs: `debugger` and whether the page is gone. */
export type PaintTarget = Pick<WebContents, 'isDestroyed'> & { readonly debugger: Pick<WebContents['debugger'], 'attach' | 'detach' | 'sendCommand'> }

const FOCUS_EMULATION = 'Emulation.setFocusEmulationEnabled'

/** Starts the hold and returns the way to end it, which may be called any number of times and does its work once. A
 * page whose debugger another client holds is left as it was: the window is then shown by window-frame.ts's timer. */
export function paintWhileHidden (contents: PaintTarget): () => void {
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
