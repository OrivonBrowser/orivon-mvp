// The registry a per-tab feature (audio, crash, pin, discard) plugs into: one
// TabSignal per feature, listed in TAB_SIGNALS, hooks the view wiring and the
// state push call for every tab. A feature owns its file under `signals/`; this
// file changes by one line per feature.
import type { WebContents, WebContentsView } from 'electron'
import type { TabRecord, TabState } from './tab-types.js'

export interface TabSignalContext {
  readonly id: string
  readonly record: TabRecord
  readonly view: WebContentsView
  readonly wc: WebContents
  /** False while this view is swapped out or parked: its events are then not the tab's. */
  readonly shown: () => boolean
}

export interface TabSignal {
  readonly name: string
  /** Once per WebContents. Read `record.host` when a listener runs (a tab that moves window keeps its listeners), and ignore events while `!shown()`. */
  wire?: (tab: TabSignalContext) => void
  /** After `wire`, and whenever a view returns to the tab (a repartition, a parked view coming back): re-applies per-webContents settings the record holds. */
  apply?: (tab: TabSignalContext) => void
  /** Runs per tab on every state push; `wc` is undefined for a destroyed page. */
  state?: (record: TabRecord, wc: WebContents | undefined) => Partial<TabState>
}

/** One line per feature, alphabetical by name. */
export const TAB_SIGNALS: readonly TabSignal[] = []

function contextFor (id: string, record: TabRecord): TabSignalContext {
  const view = record.view
  return { id, record, view, wc: view.webContents, shown: () => record.view === view }
}

/** A new view's events: every signal's `wire`, then its `apply`. */
export function wireTabSignals (id: string, record: TabRecord, signals: readonly TabSignal[] = TAB_SIGNALS): void {
  const tab = contextFor(id, record)
  for (const signal of signals) signal.wire?.(tab)
  for (const signal of signals) signal.apply?.(tab)
}

/** A parked view back in the tab: already wired, so only the settings the record holds. */
export function applyTabSignals (id: string, record: TabRecord, signals: readonly TabSignal[] = TAB_SIGNALS): void {
  const tab = contextFor(id, record)
  for (const signal of signals) signal.apply?.(tab)
}

/** What every signal adds to one tab's state. */
export function signalState (record: TabRecord, wc: WebContents | undefined, signals: readonly TabSignal[] = TAB_SIGNALS): Partial<TabState> {
  return Object.assign({}, ...signals.map((signal) => signal.state?.(record, wc) ?? {})) as Partial<TabState>
}
