// F6 and Shift+F6: move the keyboard from one part of the window to the next. The chrome knows its own panes, so
// a step made inside it is the chrome's to make (`panes` module in the renderer); this decides everything that
// crosses the chrome's edge, and the moves that start outside it.
import { sendChromeEvent } from '../shell/shell-events.js'
import type { WindowContext } from '../shell/window-context.js'
import { EXTERNAL_PANES } from './external-panes.js'
import type { ExternalPane } from './external-panes.js'
import { nextPane } from './pane-order.js'
import type { PaneName } from './pane-order.js'

export const PANES_MODULE = 'panes'

/** What the chrome is told: go in at an edge, step to the neighbouring pane, or go to one named pane. */
export type PaneEvent =
  | { type: 'enter', edge: 'first' | 'last' }
  | { type: 'step', direction: 1 | -1 }
  | { type: 'go', pane: 'address' | 'toolbar' | 'tabs' | 'bookmarks' }

/** The panes outside the chrome that are on screen, then the page, with the chrome as `address`. */
function stops (ctx: WindowContext, panes: readonly ExternalPane[]): { externals: ExternalPane[], available: PaneName[] } {
  const externals = panes.filter((pane) => pane.available(ctx))
  return { externals, available: ['address', ...externals.map((pane) => pane.name), 'page'] }
}

function focusPane (ctx: WindowContext, target: PaneName, direction: 1 | -1, externals: readonly ExternalPane[]): void {
  const { window } = ctx
  if (target === 'page') {
    window.tabs.activeWebContents()?.focus()
    return
  }
  const external = externals.find((pane) => pane.name === target)
  if (external !== undefined) {
    external.focus(ctx)
    return
  }
  window.chrome.webContents.focus()
  sendChromeEvent(window, PANES_MODULE, { type: 'enter', edge: direction === 1 ? 'first' : 'last' } satisfies PaneEvent)
}

/** Moves one pane forward (`1`) or back (`-1`) from wherever the keyboard is. Keyboard focus nowhere known counts as the page. */
export function cyclePane (ctx: WindowContext, direction: 1 | -1, panes: readonly ExternalPane[] = EXTERNAL_PANES): void {
  const { window } = ctx
  const { externals, available } = stops(ctx, panes)
  const inExternal = externals.find((pane) => pane.focused(ctx))
  if (inExternal === undefined && window.chrome.webContents.isFocused()) {
    sendChromeEvent(window, PANES_MODULE, { type: 'step', direction } satisfies PaneEvent)
    return
  }
  const target = nextPane(inExternal?.name ?? 'page', available, direction)
  if (target !== null) focusPane(ctx, target, direction, externals)
}

/** The chrome reached one of its ends: on to the first pane outside it going forward, the last going back. */
export function leaveChrome (ctx: WindowContext, direction: 1 | -1, panes: readonly ExternalPane[] = EXTERNAL_PANES): void {
  const { externals, available } = stops(ctx, panes)
  const target = nextPane(direction === 1 ? 'bookmarks' : 'address', available, direction)
  if (target !== null && target !== 'address') focusPane(ctx, target, direction, externals)
  else ctx.window.tabs.activeWebContents()?.focus()
}

/** Back to the page, from wherever the chrome had the keyboard. */
export function focusPage (ctx: WindowContext): void {
  ctx.window.tabs.activeWebContents()?.focus()
}

/** A key that names one pane of the chrome: the chrome takes the keyboard and puts it there. */
export function goToChromePane (ctx: WindowContext, pane: 'address' | 'toolbar' | 'tabs' | 'bookmarks'): void {
  ctx.window.chrome.webContents.focus()
  sendChromeEvent(ctx.window, PANES_MODULE, { type: 'go', pane } satisfies PaneEvent)
}
