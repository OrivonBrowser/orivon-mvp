// How a new shell window is to open. Types and one pure function, so the
// commands that open windows need not import the window itself.
import type { BaseWindow } from 'electron'
import type { TabManager } from './tabs.js'
import type { IntroPlan } from './intro-state.js'

export interface Placement {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface ShellWindowOptions {
  /** The process's first window on a launch that opens on the welcome screen. */
  readonly intro?: IntroPlan | undefined
  /** Where it opens, over the defaults. */
  readonly place?: Placement
  /** Fills the new window's strip, in place of the new-tab page a window opens with: a tab moved out of another window. */
  readonly first?: (tabs: TabManager) => void
  /** This is the very first window of a launch (index.ts's own two call sites, never anywhere else): the
   * window waits for its first paint before it is shown (as an `inactive` one does), and it is the only one
   * `ORIVON_WINDOW_NO_FOCUS=1` is allowed to open without taking focus (window-frame.ts's
   * `showWhenReady`). Every window opened afterward -- a new window, a tear-off, a moved tab's own window,
   * the macOS `activate` recreation -- is shown and focused regardless of the switch: nothing about opening
   * a SECOND window is the unattended-launch case that switch exists for. */
  readonly firstOfLaunch?: boolean | undefined
  /** The window opens maximized, over `place`. */
  readonly maximized?: boolean | undefined
  /** Run once, by the launch, after this window exists, with it: the windows of a restored session that come after the first. */
  readonly after?: ((first: BaseWindow) => void) | undefined
  /** Shown once it can paint, without taking focus or the front: the other windows of a restored session, which must not cover the one holding an address the person asked for. */
  readonly inactive?: boolean | undefined
  /** Its first tabs include a local file: the launch waits for the binary's fuse to be read before it makes the window (`../local-files/file-fuse.ts`). */
  readonly localFiles?: boolean | undefined
  /** Called once the window has been shown. */
  readonly shown?: (() => void) | undefined
}

/** A window opened from another one sits a little down and to the right of it, so the two are told apart. */
export function cascadeFrom (bounds: { x: number, y: number, width: number, height: number }, step = 28): Placement {
  return { x: bounds.x + step, y: bounds.y + step, width: bounds.width, height: bounds.height }
}
