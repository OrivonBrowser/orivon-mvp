import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { OverlayAnchor } from '../../main/overlays/overlay-types.js'
import type { PressButton } from '../../main/shell/press-stamps.js'
import type { OrivonShell } from '../../preload/shell.js'
import { toolbarButton } from './toolbar-button.js'

export type { OverlayAnchor }

export type ToolbarSlot = 'nav' | 'address' | 'cluster'

export interface ToolbarButtonSpec {
  id: string
  slot: ToolbarSlot
  /** Buttons in a slot sit in ascending order, whichever module added them first. */
  order: number
  label: string
  icon: () => SVGSVGElement
  onClick: (el: HTMLButtonElement, event: MouseEvent) => void
  /** The overlay this button toggles, if any: main then judges the click by the press it completes, so a press that
   * closes the open overlay does not reopen it on release however long it is held (src/main/shell/press-stamps.ts). */
  presses?: PressButton
}

export interface ChromeContext {
  readonly shell: OrivonShell
  /** The last state main pushed; null until the first push. */
  state: () => ShellState | null
  activeTab: () => TabState | undefined
  anchorFor: (el: Element) => OverlayAnchor
  toolbarButton: (spec: ToolbarButtonSpec) => HTMLButtonElement
}

/** One feature of the chrome. `render` runs on every state push; `event` on a main-to-chrome event addressed to
 * this module's `name` (`sendChromeEvent` in src/main/shell/shell-events.ts). */
export interface ChromeModule {
  readonly name: string
  init: (ctx: ChromeContext) => void
  render?: (state: ShellState, ctx: ChromeContext) => void
  event?: (payload: unknown, ctx: ChromeContext) => void
}

/** Adds to a tab's element. The element lives as long as its tab; the strip returns it to its plain look and calls
 * every decorator again whenever the tab, its place among the others, its group or the active tab changes, so a
 * decorator draws everything it owns each time, from the tab, `state.tabs`, `state.groups` and `state.activeTabId`
 * alone. It leaves the tab's icon (`.fav`) to the strip, except to replace its content. */
export type TabDecorator = (el: HTMLElement, tab: TabState, state: ShellState, ctx: ChromeContext) => void

// TS control-flow narrowing does not persist into closures (event listener callbacks, functions declared
// below) even for `const` bindings that are never reassigned. `must` makes the type non-nullable at the
// source instead of relying on narrowing that does not survive past that point.
export function must<T> (value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

/** A tab that is showing a site: not the new-tab page, and not one of the shell's own pages, which have no
 * shield, no permissions and nothing to bookmark. */
export function hasSite (tab: TabState | undefined): tab is TabState {
  return tab !== undefined && !tab.isNewTab && !tab.isInternal
}

/** A plain object, not a DOMRect: contextBridge deep-clones what crosses it, and a DOMRect's values live on its
 * prototype rather than as own properties, so it arrives in main as `{}`. Measured at click time, not cached:
 * the window may have been resized, and the bookmarks bar appearing or disappearing moves nothing in this row
 * but the toolbar's own width does shift these buttons. */
export function anchorFor (el: Element): OverlayAnchor {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/** The context every module shares, and the function main.ts calls with each pushed state. */
export function createChromeContext (shell: OrivonShell): { ctx: ChromeContext, setState: (state: ShellState) => void } {
  let current: ShellState | null = null
  const ctx: ChromeContext = {
    shell,
    state: () => current,
    activeTab: () => current?.tabs.find((t) => t.id === current?.activeTabId),
    anchorFor,
    toolbarButton: (spec) => toolbarButton(spec, shell)
  }
  return { ctx, setState: (state) => { current = state } }
}
