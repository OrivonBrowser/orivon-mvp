// How the loaded pages are laid out: under a heading for each day, each day's pages in one run or, by session,
// in the sessions that ended on it. Pure, so what is on screen and what the keys move through are one list.
import type { HistoryEntry, HistoryOrder } from '../../../main/history/history-store.js'
import { dayLabel } from './days.js'
import { groupBySession, sessionLabel } from './sessions.js'

export type Grouping = 'day' | 'session'

export interface Block {
  /** Set for a session: its heading. A plain run has none. */
  readonly heading?: { readonly key: number, readonly label: string, readonly pages: number }
  readonly collapsed: boolean
  readonly entries: readonly HistoryEntry[]
}

export interface Section {
  /** Empty for a sorted list, which is flat. */
  readonly label: string
  readonly blocks: readonly Block[]
}

export interface LayoutInput {
  readonly entries: readonly HistoryEntry[]
  readonly order: HistoryOrder
  readonly grouping: Grouping
  readonly collapsed: ReadonlySet<number>
  readonly now: number
  readonly locale?: string
}

export function buildLayout ({ entries, order, grouping, collapsed, now, locale }: LayoutInput): Section[] {
  if (entries.length === 0) return []
  if (order !== 'recent') return [{ label: '', blocks: [{ collapsed: false, entries }] }]
  const sections: Array<{ label: string, blocks: Block[] }> = []
  const sectionFor = (time: number): Block[] => {
    const label = dayLabel(time, now, locale)
    const last = sections.at(-1)
    if (last?.label === label) return last.blocks
    const blocks: Block[] = []
    sections.push({ label, blocks })
    return blocks
  }
  if (grouping === 'day') {
    for (const entry of entries) {
      const blocks = sectionFor(entry.lastVisit)
      const run = blocks[0]
      if (run === undefined) blocks.push({ collapsed: false, entries: [entry] })
      else (run.entries as HistoryEntry[]).push(entry)
    }
    return sections
  }
  for (const session of groupBySession(entries)) {
    sectionFor(session.end).push({
      heading: { key: session.key, label: sessionLabel(session, now, locale), pages: session.entries.length },
      collapsed: collapsed.has(session.key),
      entries: session.entries
    })
  }
  return sections
}

/** The ids the keys move through, top to bottom: the rows on screen, not those under a collapsed session. */
export function visibleIds (sections: readonly Section[]): number[] {
  return sections.flatMap((section) => section.blocks.flatMap((block) => block.collapsed ? [] : block.entries.map((entry) => entry.id)))
}
