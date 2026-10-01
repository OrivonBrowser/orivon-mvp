import { describe, expect, it } from 'vitest'
import { asGuest, asGuests, asLimits, asRows, asShown } from '../overlay/side-panel/shown.js'

const view = { id: 'bookmarks', title: 'Bookmarks', icon: 'bookmarks', searchLabel: 'Search bookmarks', things: 'bookmarks', page: null, removable: true, empty: 'Bookmarks you save appear here.' }
const shown = { views: [view], guests: [{ id: 'ext:a', title: 'Notes' }], view: 'bookmarks', guest: null, side: 'right', width: 360, limits: { min: 280, max: 640, reset: 360 }, isPrivate: false, defaultOpen: ['bar'], rows: [{ id: 'a', kind: 'item', title: 'Alpha' }] }

describe('asShown', () => {
  it('reads what main sends', () => {
    expect(asShown(shown)).toEqual(shown)
  })

  it('drops the whole message for a field of the wrong shape', () => {
    for (const bad of [null, 'x', { ...shown, side: 'top' }, { ...shown, width: '360' }, { ...shown, limits: { min: 1 } }, { ...shown, views: 'bookmarks' }, { ...shown, isPrivate: 'no' }]) expect(asShown(bad)).toBeNull()
  })

  it('leaves out a view or a row that is not one, and keeps the rest', () => {
    const next = asShown({ ...shown, views: [view, { ...view, icon: 'skull' }, 4], rows: [...shown.rows, { id: 5 }, { id: 'h', kind: 'weird', title: 'x' }] })
    expect(next?.views).toEqual([view])
    expect(next?.rows).toEqual(shown.rows)
  })

  it('accepts a missing guest list and rows', () => {
    const { guests: _guests, rows: _rows, ...rest } = shown
    expect(asShown(rest)).toMatchObject({ guests: [], rows: [] })
  })
})

describe('the small readers', () => {
  it('reads limits, a guest and a guest list, and nothing else', () => {
    expect(asLimits({ min: 1, max: 2, reset: 1 })).toEqual({ min: 1, max: 2, reset: 1 })
    expect(asLimits({ min: 1, max: 'x', reset: 1 })).toBeNull()
    expect(asGuest({ id: 'ext:a', title: 'A', icon: 'data:image/png;base64,AA' })).toEqual({ id: 'ext:a', title: 'A', icon: 'data:image/png;base64,AA' })
    expect(asGuest({ id: 'ext:a' })).toBeNull()
    expect(asGuests([{ id: 'ext:a', title: 'A' }, 3, { id: 1 }])).toEqual([{ id: 'ext:a', title: 'A' }])
    expect(asGuests('nope')).toEqual([])
    expect(asRows('nope')).toEqual([])
  })
})
