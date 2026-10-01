// The views the panel draws itself, in the order the picker lists them.
import { bookmarksView } from './views/bookmarks.js'
import { downloadsView } from './views/downloads.js'
import { historyView } from './views/history.js'
import { readingView } from './views/reading.js'
import type { PanelViewDef } from './panel-types.js'

export type { PanelIcon, PanelRow, PanelViewDef } from './panel-types.js'

export const PANEL_VIEWS: readonly PanelViewDef[] = [
  bookmarksView,
  historyView,
  readingView,
  downloadsView
]

export function viewById (id: string): PanelViewDef | undefined {
  return PANEL_VIEWS.find((view) => view.id === id)
}

