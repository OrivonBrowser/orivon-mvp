import { describe, expect, it } from 'vitest'
import { dropAt, nudgeIndex } from '../drop-target.js'
import type { RowBox } from '../drop-target.js'

const boxes: RowBox[] = [
  { id: 'a', top: 0, bottom: 40, folder: false },
  { id: 'f', top: 40, bottom: 80, folder: true },
  { id: 'b', top: 80, bottom: 120, folder: false }
]
const none = new Set<string>()

describe('dropAt', () => {
  it('drops above the first row and below the last', () => {
    expect(dropAt(-5, boxes, none)).toEqual({ kind: 'between', index: 0, line: 0 })
    expect(dropAt(130, boxes, none)).toEqual({ kind: 'between', index: 3, line: 120 })
  })

  it('splits a page row at its middle', () => {
    expect(dropAt(10, boxes, none)).toEqual({ kind: 'between', index: 0, line: 0 })
    expect(dropAt(30, boxes, none)).toEqual({ kind: 'between', index: 1, line: 40 })
  })

  it('files into a folder by its middle half and between by its edges', () => {
    expect(dropAt(60, boxes, none)).toEqual({ kind: 'into', id: 'f' })
    expect(dropAt(42, boxes, none)).toEqual({ kind: 'between', index: 1, line: 40 })
    expect(dropAt(78, boxes, none)).toEqual({ kind: 'between', index: 2, line: 80 })
  })

  it('never files a dragged folder into itself', () => {
    expect(dropAt(60, boxes, new Set(['f']))).toEqual({ kind: 'between', index: 2, line: 80 })
  })

  it('reads the gap between two rows as the gap before the lower one', () => {
    const spaced: RowBox[] = [{ id: 'a', top: 0, bottom: 38, folder: false }, { id: 'b', top: 40, bottom: 78, folder: false }]
    expect(dropAt(39, spaced, none)).toEqual({ kind: 'between', index: 1, line: 40 })
  })

  it('has no place in an empty list', () => {
    expect(dropAt(10, [], none)).toBeNull()
  })
})

describe('nudgeIndex', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves one row up or down by one place, as a position in the list as it stands', () => {
    expect(nudgeIndex(ids, new Set(['c']), 'up')).toBe(1)
    expect(nudgeIndex(ids, new Set(['b']), 'down')).toBe(3)
  })

  it('moves a group by its edge', () => {
    expect(nudgeIndex(ids, new Set(['b', 'c']), 'up')).toBe(0)
    expect(nudgeIndex(ids, new Set(['b', 'c']), 'down')).toBe(4)
  })

  it('stops at the ends and with nothing chosen', () => {
    expect(nudgeIndex(ids, new Set(['a']), 'up')).toBeNull()
    expect(nudgeIndex(ids, new Set(['d']), 'down')).toBeNull()
    expect(nudgeIndex(ids, new Set(), 'up')).toBeNull()
  })
})
