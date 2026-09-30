// What the History page is showing and has chosen: one object, read by the modules that draw it and the ones that
// react to keys, so nothing is held in two places.
import type { HistoryEntry, HistoryOrder } from '../../../main/history/history-store.js'
import type { HistoryStatus } from '../../../main/history/history-service.js'
import type { Grouping, Section } from './layout.js'
import { visibleIds } from './layout.js'
import type { ClosedRow } from './view-closed.js'

export const PAGE_SIZE = 100

export interface PageState {
  entries: HistoryEntry[]
  status: HistoryStatus | null
  /** The last request filled its page, so there may be more. */
  more: boolean
  /** A request for the next page is on its way. */
  loadingMore: boolean
  query: string
  order: HistoryOrder
  grouping: Grouping
  selected: Set<number>
  /** Where a shift-extended choice starts from. */
  anchor: number | null
  /** The row the keys act on, and the one in the tab order. */
  focusId: number | null
  /** Sessions folded shut, by `Session.key`. */
  collapsed: Set<number>
  closed: ClosedRow[]
  /** Delete has been pressed once on several rows. */
  armed: boolean
  sections: Section[]
}

export const state: PageState = {
  entries: [], status: null, more: false, loadingMore: false, query: '', order: 'recent', grouping: 'day',
  selected: new Set(), anchor: null, focusId: null, collapsed: new Set(), closed: [], armed: false, sections: []
}

/** The ids on screen, top to bottom. */
export const visible = (): number[] => visibleIds(state.sections)
