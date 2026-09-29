import { describe, expect, it } from 'vitest'
import { splitZoneFor } from '../split-drop.js'

const AREA = { x: 0, y: 100, width: 1000, height: 600 }

describe('splitZoneFor', () => {
  it('names the edge a dragged tab is over', () => {
    expect(splitZoneFor('active', 'dragged', AREA, { x: 20, y: 400 })).toBe('left')
    expect(splitZoneFor('active', 'dragged', AREA, { x: 980, y: 400 })).toBe('right')
  })

  it('names none in the middle of the page or over the window\'s top', () => {
    expect(splitZoneFor('active', 'dragged', AREA, { x: 500, y: 400 })).toBeNull()
    expect(splitZoneFor('active', 'dragged', AREA, { x: 20, y: 50 })).toBeNull()
  })

  it('names none for the tab that is already showing, or when nothing is', () => {
    expect(splitZoneFor('same', 'same', AREA, { x: 20, y: 400 })).toBeNull()
    expect(splitZoneFor(null, 'dragged', AREA, { x: 20, y: 400 })).toBeNull()
  })

  it('takes an explicit, narrower share when given one -- window-actions.ts\'s own TAB_DRAG_SPLIT_SHARE', () => {
    const point = { x: 200, y: 400 } // fx = 0.2: a left edge at the default share, not at a narrower one
    expect(splitZoneFor('active', 'dragged', AREA, point)).toBe('left')
    expect(splitZoneFor('active', 'dragged', AREA, point, 0.12)).toBeNull()
  })
})
