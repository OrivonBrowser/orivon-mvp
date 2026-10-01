// What the dropdown page accepts from main: a numbered list of rows and the selected one. Anything that is not
// shaped as main builds it is dropped, since the page draws text that came from web pages.
import type { PageRow } from '../../../main/omnibox/omnibox-service.js'

export interface RowsMessage { seq: number, rev: number, rows: PageRow[], selected: number }

const KINDS = ['verbatim', 'search', 'history', 'bookmark', 'tab']
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function ranges (value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return []
  return value.filter((pair): pair is [number, number] =>
    Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1]) && (pair[0] as number) >= 0 && (pair[1] as number) > (pair[0] as number))
}

function asRow (value: unknown): PageRow | null {
  if (!isRecord(value)) return null
  const { kind, title, address, favicon, meta, match, addressMatch } = value
  if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof title !== 'string' || typeof address !== 'string') return null
  return {
    kind: kind as PageRow['kind'],
    title,
    address,
    favicon: typeof favicon === 'string' && favicon.startsWith('data:image/') ? favicon : null,
    meta: typeof meta === 'string' ? meta : '',
    match: ranges(match),
    addressMatch: ranges(addressMatch)
  }
}

/** The message of a show or an update, or null when it is not one. */
export function asRowsMessage (value: unknown): RowsMessage | null {
  if (!isRecord(value) || typeof value['seq'] !== 'number' || !Array.isArray(value['rows'])) return null
  const rows = value['rows'].map(asRow).filter((row): row is PageRow => row !== null)
  const selected = typeof value['selected'] === 'number' && Number.isInteger(value['selected']) ? value['selected'] : 0
  return { seq: value['seq'], rev: typeof value['rev'] === 'number' ? value['rev'] : 0, rows, selected: Math.min(Math.max(selected, 0), Math.max(rows.length - 1, 0)) }
}

/** What Ctrl or Command with a click asks for, and what a middle press always does. */
export function dispositionFor (event: { button: number, ctrlKey: boolean, metaKey: boolean }): 'current' | 'background' | null {
  if (event.button === 1) return 'background'
  if (event.button !== 0) return null
  return event.ctrlKey || event.metaKey ? 'background' : 'current'
}
