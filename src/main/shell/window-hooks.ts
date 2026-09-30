// What a feature does when a window opens or closes, without window.ts naming it.
// One line per hook in WINDOW_HOOKS, alphabetical.
import type { WindowContext } from './window-context.js'
import type { ShellWindowOptions } from './window-options.js'

export interface WindowHook {
  readonly name: string
  /** The first tabs exist and the window is not shown yet. */
  opened?: (ctx: WindowContext, options: ShellWindowOptions) => void
  /** In the window's `close`, before its tabs are disposed: the views are still alive. */
  closing?: (ctx: WindowContext) => void
}

export const WINDOW_HOOKS: readonly WindowHook[] = []

/** A hook that throws is logged and skipped: a throw out of a window event would reach Electron's error dialog. */
export function runWindowHooks (
  phase: 'opened' | 'closing', ctx: WindowContext, options: ShellWindowOptions, hooks: readonly WindowHook[] = WINDOW_HOOKS
): void {
  for (const hook of hooks) {
    try {
      if (phase === 'opened') hook.opened?.(ctx, options)
      else hook.closing?.(ctx)
    } catch (error) {
      console.error(`[window] the ${hook.name} hook failed on ${phase}:`, error)
    }
  }
}
