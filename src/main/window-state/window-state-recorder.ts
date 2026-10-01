// Keeps the window-state store current with the window the person last moved, resized or maximised.
import type { WindowHook } from '../shell/window-hooks.js'
import type { WindowContext } from '../shell/window-context.js'

/** The BaseWindow members this reads, so a test can stand in for the window. */
export interface RecordedWindow {
  on: (event: 'resize' | 'move' | 'maximize' | 'unmaximize', listener: () => void) => unknown
  getNormalBounds: () => { x: number, y: number, width: number, height: number }
  isMaximized: () => boolean
  isFullScreen: () => boolean
  isMinimized: () => boolean
  isKiosk: () => boolean
  isDestroyed: () => boolean
}

/** One capture: a window in full screen (HTML full screen included), minimised or in a kiosk is not at a place
 * the person chose, so it leaves the last one alone. */
function capture ({ window, services }: WindowContext): void {
  const win = window.window as unknown as RecordedWindow
  if (win.isDestroyed() || win.isFullScreen() || win.isMinimized() || win.isKiosk()) return
  services.windowState.set({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })
}

export const windowStateRecorder: WindowHook = {
  name: 'window-state',
  opened: (ctx) => {
    const win = ctx.window.window as unknown as RecordedWindow
    let queued = false
    // The bounds read inside the event itself are the old ones under X11: one macrotask later they have settled.
    // Events arrive in bursts while a window is dragged, so they share one read.
    const schedule = (): void => {
      if (queued) return
      queued = true
      setImmediate(() => { queued = false; capture(ctx) })
    }
    for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(event, schedule)
  },
  closing: (ctx) => { capture(ctx) }
}
