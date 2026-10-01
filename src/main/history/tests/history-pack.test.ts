import { describe, expect, it } from 'vitest'
import { unpackEntries } from '../../../renderer/pages/history/unpack.js'
import { packEntries } from '../history-pack.js'
import type { HistoryEntry } from '../history-store.js'

const ICON = `data:image/png;base64,${'A'.repeat(6000)}`
const OTHER = 'data:image/gif;base64,R0lGODlhAQAB'
const entry = (id: number, favicon?: string | null): HistoryEntry => ({
  id, url: `https://s${String(id)}.example/`, title: `S${String(id)}`, lastVisit: id, visitCount: 1, ...(favicon === undefined ? {} : { favicon })
})

describe('packEntries', () => {
  it('sends an icon once however many rows of a site carry it', () => {
    const rows = Array.from({ length: 100 }, (_, id) => entry(id, ICON))
    const packed = packEntries(rows)
    expect(packed.icons).toEqual([ICON])
    expect(JSON.stringify(packed).length).toBeLessThan(ICON.length + 100 * 150)
    expect(packed.entries.every((row) => row.icon === 0 && !('favicon' in row))).toBe(true)
  })

  it('numbers distinct icons in the order met and leaves a row with none as it was', () => {
    const packed = packEntries([entry(1, OTHER), entry(2), entry(3, null), entry(4, ICON), entry(5, OTHER)])
    expect(packed.icons).toEqual([OTHER, ICON])
    expect(packed.entries.map((row) => row.icon)).toEqual([0, undefined, undefined, 1, 0])
  })

  it('is read back as the rows it was made from', () => {
    const rows = [entry(1, OTHER), entry(2), entry(3, ICON), entry(4, OTHER)]
    const packed = packEntries(rows)
    expect(unpackEntries(packed.entries, packed.icons)).toEqual([entry(1, OTHER), entry(2), entry(3, ICON), entry(4, OTHER)])
  })

  it('reads a position that names no icon as a row without one', () => {
    expect(unpackEntries([{ ...entry(1), icon: 7 }], [])).toEqual([entry(1)])
  })
})
