// Panes outside the chrome and outside the page that F6 can stop at, such as a docked side panel. A feature adds
// one entry; `available` is false while the pane is not on screen, so cycling skips it.
import type { WindowContext } from '../shell/window-context.js'
import type { PaneName } from './pane-order.js'
import { sidePanelPane } from '../side-panel/side-panel-pane.js'

export interface ExternalPane {
  readonly name: PaneName
  available: (ctx: WindowContext) => boolean
  /** Whether keyboard focus is inside this pane now. */
  focused: (ctx: WindowContext) => boolean
  focus: (ctx: WindowContext) => void
}

/** One line per pane, in the order the panes sit between the chrome and the page. */
export const EXTERNAL_PANES: readonly ExternalPane[] = [
  sidePanelPane
]
