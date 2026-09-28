// How a new shell window is to open. Types and one pure function, so the
// commands that open windows need not import the window itself.
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
}

/** A window opened from another one sits a little down and to the right of it, so the two are told apart. */
export function cascadeFrom (bounds: { x: number, y: number, width: number, height: number }, step = 28): Placement {
  return { x: bounds.x + step, y: bounds.y + step, width: bounds.width, height: bounds.height }
}
