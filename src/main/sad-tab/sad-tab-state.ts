// What is wrong with a tab's page, read off its record. A crash is on the record itself; a page that stopped
// answering is only remembered here, since it needs no mark on the strip.
import type { TabRecord } from '../shell/tab-types.js'

export type PageTrouble =
  | { readonly kind: 'crashed', readonly reason: string }
  | { readonly kind: 'unresponsive' }

/** `hung`: the page stopped answering. `waived`: the person chose to wait, which holds until the next `unresponsive` event. */
const hangs = new WeakMap<TabRecord, 'hung' | 'waived'>()

export function markUnresponsive (record: TabRecord): void {
  hangs.set(record, 'hung')
}

export function markResponsive (record: TabRecord): void {
  hangs.delete(record)
}

export function waiveUnresponsive (record: TabRecord): void {
  if (hangs.has(record)) hangs.set(record, 'waived')
}

/** The trouble the card reports for this tab, or null. A crash outranks a hang. */
export function troubleOf (record: TabRecord): PageTrouble | null {
  if (record.crashed !== undefined && record.crashed !== null) return { kind: 'crashed', reason: record.crashed }
  return hangs.get(record) === 'hung' ? { kind: 'unresponsive' } : null
}
