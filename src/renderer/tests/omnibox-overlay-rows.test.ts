import { describe, expect, it } from 'vitest'
import { asRowsMessage, dispositionFor } from '../overlay/omnibox/rows.js'

const row = { kind: 'history', title: 'T', address: 'a.org', favicon: null, meta: '', match: [[0, 1]], addressMatch: [] }

describe('asRowsMessage', () => {
  it('reads a numbered list of rows and the selected one', () => {
    expect(asRowsMessage({ seq: 4, rows: [row, { ...row, kind: 'tab', meta: 'Switch to this tab' }], selected: 1 })).toMatchObject({ seq: 4, selected: 1 })
  })

  it('drops a row that is not shaped as main builds it, and a range that is not a range', () => {
    const message = asRowsMessage({ seq: 1, rows: [row, { kind: 'nonsense', title: 'x', address: '' }, { kind: 'history', title: 3, address: '' }, null, 'x', { ...row, match: [[2, 1], [0, 2], ['a', 'b'], [0]] }], selected: 0 })
    expect(message?.rows).toHaveLength(2)
    expect(message?.rows[1]?.match).toEqual([[0, 2]])
  })

  it('keeps only an image as an icon', () => {
    expect(asRowsMessage({ seq: 1, rows: [{ ...row, favicon: 'data:image/png;base64,AA==' }, { ...row, favicon: 'https://x.org/i.png' }, { ...row, favicon: 'data:text/html,x' }], selected: 0 })?.rows.map((r) => r.favicon))
      .toEqual(['data:image/png;base64,AA==', null, null])
  })

  it('keeps the selection inside the rows', () => {
    expect(asRowsMessage({ seq: 1, rows: [row], selected: 5 })?.selected).toBe(0)
    expect(asRowsMessage({ seq: 1, rows: [row, row], selected: -3 })?.selected).toBe(0)
    expect(asRowsMessage({ seq: 1, rows: [], selected: 2 })?.selected).toBe(0)
  })

  it.each([null, undefined, 'x', 3, {}, { seq: 'a', rows: [] }, { seq: 1, rows: 'x' }])('is not a message: %j', (value) => {
    expect(asRowsMessage(value)).toBeNull()
  })
})

describe('dispositionFor', () => {
  it('goes here for a plain press, and to a background tab for Ctrl, Command or the middle button', () => {
    expect(dispositionFor({ button: 0, ctrlKey: false, metaKey: false })).toBe('current')
    expect(dispositionFor({ button: 0, ctrlKey: true, metaKey: false })).toBe('background')
    expect(dispositionFor({ button: 0, ctrlKey: false, metaKey: true })).toBe('background')
    expect(dispositionFor({ button: 1, ctrlKey: false, metaKey: false })).toBe('background')
  })

  it('ignores the right button', () => {
    expect(dispositionFor({ button: 2, ctrlKey: false, metaKey: false })).toBeNull()
  })
})
