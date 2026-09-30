// What the chooser reads from the show payload and how its keys move the selection. Pure, so it is tested
// without a document.
import type { Step } from '../../pages/shared/list-selection.js'

export interface ChooserRow { id: string, username: string }
export interface Chooser { logins: ChooserRow[], generated: string | null, mode: 'button' | 'field' }

/** Eight dots stand for the password on every row: the real one is never sent to this page. */
export const DOTS = '•'.repeat(8)

export function chooserFrom (payload: unknown): Chooser {
  const empty: Chooser = { logins: [], generated: null, mode: 'button' }
  if (typeof payload !== 'object' || payload === null) return empty
  const { logins, generated, mode } = payload as Record<string, unknown>
  const rows = Array.isArray(logins)
    ? logins.flatMap((row): ChooserRow[] => {
      if (typeof row !== 'object' || row === null) return []
      const { id, username } = row as Record<string, unknown>
      return typeof id === 'string' && typeof username === 'string' ? [{ id, username }] : []
    })
    : []
  return { logins: rows, generated: typeof generated === 'string' && generated !== '' ? generated : null, mode: mode === 'field' ? 'field' : 'button' }
}

/** The move a key asks for, or null when it is not a list key. */
export function stepFor (key: string): Step | null {
  switch (key) {
    case 'ArrowDown': return 'down'
    case 'ArrowUp': return 'up'
    case 'Home': return 'first'
    case 'End': return 'last'
    default: return null
  }
}

/** The row main says is chosen: a whole number inside the list, or -1 for none. */
export function selectionFrom (event: unknown, count: number): number | null {
  if (typeof event !== 'object' || event === null) return null
  const { type, index } = event as Record<string, unknown>
  if (type !== 'select' || typeof index !== 'number' || !Number.isInteger(index)) return null
  return index >= -1 && index < count ? index : null
}
