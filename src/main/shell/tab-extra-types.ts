// Shapes that tab groups and sleeping tabs share between the tab record, the state pushed to the chrome and
// the session file. Types only, so anything may import them.
import type { NavigationEntry } from 'electron'

/** What a sleeping tab keeps: where it was, and its history, so waking it puts the person back on the page. */
export interface SleepingTab {
  url: string
  title: string
  favicon: string | null
  /** The tab's back and forward list when it went to sleep, and the index of the entry that was shown. */
  entries: NavigationEntry[]
  index: number
  /** When it went to sleep, in milliseconds since the epoch. */
  at: number
}

export type GroupColor = 'gray' | 'blue' | 'red' | 'orange' | 'green' | 'pink' | 'purple' | 'teal'

export interface TabGroupState {
  id: string
  title: string
  color: GroupColor
  collapsed: boolean
}
