// The registry a feature adds a field of the chrome's state through: one
// ShellStatePart per feature, listed in SHELL_STATE_PARTS. The field itself is
// one line in `ShellState` (tab-types.ts). window-state.ts reads every part on
// each push and starts every part's watcher with the window.
import type { ShellState, TabsSnapshot } from './tab-types.js'
import type { WindowContext } from './window-context.js'

export interface ShellStatePart {
  readonly name: string
  /** What this part adds to one push. Runs on every push, so it reads memory, never a disk. */
  read: (ctx: WindowContext, tabs: TabsSnapshot) => Partial<ShellState>
  /** Calls `push` when the part's source changes; returns the stop, run when the window closes. */
  watch?: (ctx: WindowContext, push: () => void) => () => void
}

/** One line per feature, alphabetical by name. */
export const SHELL_STATE_PARTS: readonly ShellStatePart[] = []

/** What every part adds to a push, merged. */
export function readStateParts (ctx: WindowContext, tabs: TabsSnapshot, parts: readonly ShellStatePart[] = SHELL_STATE_PARTS): Partial<ShellState> {
  return Object.assign({}, ...parts.map((part) => part.read(ctx, tabs))) as Partial<ShellState>
}

/** Starts every part's watcher; the returned function stops them all. */
export function watchStateParts (ctx: WindowContext, push: () => void, parts: readonly ShellStatePart[] = SHELL_STATE_PARTS): () => void {
  const stops = parts.flatMap((part) => part.watch === undefined ? [] : [part.watch(ctx, push)])
  return () => { for (const stop of stops) stop() }
}
