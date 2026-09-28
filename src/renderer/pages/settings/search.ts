// Finds settings by what a person types. Reads the same rows the page renders,
// so a row that is not shown (its `visible` says no) is not found either.
import type { Row, Section } from './model.js'

export interface SearchHit {
  readonly section: Section
  readonly row: Row
}

/** Lower is better. `undefined`: the row does not match. */
function rank (section: Section, row: Row, query: string, words: readonly string[]): number | undefined {
  const label = row.label.toLowerCase()
  const help = (row.help ?? '').toLowerCase()
  const keywords = (row.keywords ?? []).join(' ').toLowerCase()
  const title = section.title.toLowerCase()
  const haystack = `${label} ${help} ${keywords} ${title}`
  if (!words.every((word) => haystack.includes(word))) return undefined
  if (label.startsWith(query)) return 0
  if (label.includes(query)) return 1
  if (keywords.includes(query)) return 2
  if (help.includes(query)) return 3
  return 4
}

/** Every matching row, best first; rows that rank alike keep their order on the page. */
export function searchRows (sections: readonly Section[], text: string, isShown: (row: Row) => boolean): SearchHit[] {
  const query = text.trim().toLowerCase()
  if (query === '') return []
  const words = query.split(/\s+/)
  const hits: Array<SearchHit & { rank: number, order: number }> = []
  let order = 0
  for (const section of sections) {
    for (const row of section.rows) {
      order += 1
      if (!isShown(row)) continue
      const score = rank(section, row, query, words)
      if (score !== undefined) hits.push({ section, row, rank: score, order })
    }
  }
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return hits.map(({ section, row }) => ({ section, row }))
}
