// What the Extensions menu page decides without a document: which payload to
// trust, which controls a row has, and where a key moves. Plain functions, so
// they are tested without a DOM.
import type { MenuPayload, MenuRow } from '../../../main/extensions/extensions-menu-model.js'

export type { MenuPayload, MenuRow }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A show or a reply as main builds it; anything else is an empty menu. */
export function asPayload (value: unknown): MenuPayload | undefined {
  if (!isRecord(value) || !Array.isArray(value['rows'])) return undefined
  const rows = value['rows'].filter((row): row is MenuRow => isRecord(row) && typeof row['id'] === 'string' && typeof row['name'] === 'string' && typeof row['pinned'] === 'boolean')
  return {
    site: typeof value['site'] === 'string' ? value['site'] : null,
    activatable: value['activatable'] !== false,
    rows
  }
}

/** The control a Left or Right key reaches from index `at` of a line's `count` controls; it stops at the ends. */
export function stepControl (count: number, at: number, delta: -1 | 1): number {
  return Math.min(count - 1, Math.max(0, at + delta))
}

/** The row a typed letter jumps to: the next name after `from` that starts with it, wrapping, or -1. */
export function jumpTo (names: readonly string[], from: number, letter: string): number {
  if (letter.length !== 1) return -1
  const wanted = letter.toLocaleLowerCase()
  for (let step = 1; step <= names.length; step += 1) {
    const index = (from + step + names.length) % names.length
    if (names[index]?.toLocaleLowerCase().startsWith(wanted) === true) return index
  }
  return -1
}

/** "on example.com" for the heading, or nothing when the page is not a site. */
export function siteLine (site: string | null): string {
  return site === null ? '' : `on ${site}`
}

/** The accessible name of a row's main control: the extension, and its badge when it shows one. */
export function rowLabel (row: MenuRow): string {
  return row.badge === '' ? row.name : `${row.name}, ${row.badge}`
}
