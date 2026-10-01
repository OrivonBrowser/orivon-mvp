// The side panel as a stop of the F6 order, between the bookmarks bar and the page.
import type { ExternalPane } from '../focus/external-panes.js'
import { panelOf } from './side-panel-host.js'

export const sidePanelPane: ExternalPane = {
  name: 'side-panel',
  available: ({ window }) => panelOf(window)?.onScreen() === true,
  focused: ({ window }) => panelOf(window)?.holdsFocus() === true,
  focus: ({ window }) => { panelOf(window)?.focusIn() }
}
