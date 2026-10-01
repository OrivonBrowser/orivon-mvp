import { describe, expect, it } from 'vitest'
import { dropPosition, nextStop, parseBarItems, visibleCount } from '../chrome/bar-overflow.js'
import { CHROME_MODULES } from '../chrome/modules.js'

describe('visibleCount', () => {
  const widths = [100, 100, 100, 100]

  it('shows every item when they all fit, with no room kept for the overflow button', () => {
    expect(visibleCount(widths, 412, 4, 24)).toBe(4)
    expect(visibleCount([], 300, 4, 24)).toBe(0)
  })

  it('keeps room for the overflow button once any item is hidden', () => {
    // 411 is one px short of all four: three items and the button (3*100 + 2*4 + 4 + 24 = 336) fit, four do not.
    expect(visibleCount(widths, 411, 4, 24)).toBe(3)
    expect(visibleCount(widths, 336, 4, 24)).toBe(3)
    expect(visibleCount(widths, 335, 4, 24)).toBe(2)
  })

  it('hides all when not even one item and the button fit', () => {
    expect(visibleCount(widths, 120, 4, 24)).toBe(0)
    expect(visibleCount(widths, 0, 4, 24)).toBe(0)
  })

  it('stops at the first item that does not fit, even if a later narrower one would', () => {
    expect(visibleCount([100, 300, 20], 250, 4, 24)).toBe(1)
  })
})

describe('nextStop', () => {
  it('moves one stop and stops at the ends', () => {
    expect(nextStop(4, 1, 'ArrowRight')).toBe(2)
    expect(nextStop(4, 1, 'ArrowLeft')).toBe(0)
    expect(nextStop(4, 3, 'ArrowRight')).toBe(3)
    expect(nextStop(4, 0, 'ArrowLeft')).toBe(0)
    expect(nextStop(4, 2, 'Home')).toBe(0)
    expect(nextStop(4, 1, 'End')).toBe(3)
    expect(nextStop(0, 0, 'End')).toBe(-1)
  })
})

describe('dropPosition', () => {
  it('drops before the first item whose centre is to the right of the pointer', () => {
    const centres = [50, 150, 250]
    expect(dropPosition(centres, 10)).toBe(0)
    expect(dropPosition(centres, 100)).toBe(1)
    expect(dropPosition(centres, 200)).toBe(2)
    expect(dropPosition(centres, 400)).toBe(3)
    expect(dropPosition([], 5)).toBe(0)
  })
})

describe('parseBarItems', () => {
  it('reads the list main sends, with a missing icon as none', () => {
    expect(parseBarItems([{ id: 'a', kind: 'url', title: 'A', url: 'https://a.example/', favicon: 'data:image/png;base64,x' }, { id: 'b', kind: 'folder', title: 'B' }])).toEqual([
      { id: 'a', kind: 'url', title: 'A', url: 'https://a.example/', favicon: 'data:image/png;base64,x' },
      { id: 'b', kind: 'folder', title: 'B', favicon: null }
    ])
    expect(parseBarItems([])).toEqual([])
  })

  it('refuses anything that is not a list of items', () => {
    for (const bad of [undefined, null, 'x', {}, [null], ['x'], [{ id: 1, kind: 'url', title: 'A' }], [{ id: 'a', kind: 'other', title: 'A' }], [{ id: 'a', kind: 'url' }]]) {
      expect(parseBarItems(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the bookmarks bar module', () => {
  it('is one of the chrome modules, named for the events main sends it', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('bookmarks-bar')
  })
})
