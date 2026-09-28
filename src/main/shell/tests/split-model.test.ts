import { describe, expect, it } from 'vitest'
import { GAP, MARGIN, MAX_RATIO, MIN_PANE_PX, MIN_RATIO, SplitGroups, clampRatio, isFirstPane, orientationOf, paneRects, ratioAt, zoneAt, zoneHalf } from '../split-model.js'

const AREA = { x: 0, y: 100, width: 1000, height: 600 }

describe('paneRects', () => {
  it('shares a row between two panes with a gap between them and a margin round them', () => {
    const rects = paneRects(AREA, 'row', 0.5)
    expect(rects).not.toBeNull()
    if (rects === null) return
    const room = 1000 - 2 * MARGIN - GAP
    expect(rects.a).toEqual({ x: MARGIN, y: 100 + MARGIN, width: room / 2, height: 600 - 2 * MARGIN })
    expect(rects.b.x).toBe(MARGIN + room / 2 + GAP)
    expect(rects.b.width).toBe(room / 2)
    expect(rects.divider).toEqual({ x: MARGIN + room / 2, y: 100 + MARGIN, width: GAP, height: 600 - 2 * MARGIN })
    expect(rects.a.width + GAP + rects.b.width + 2 * MARGIN).toBe(1000)
  })

  it('stacks a column the same way', () => {
    const rects = paneRects(AREA, 'column', 0.25)
    expect(rects).not.toBeNull()
    if (rects === null) return
    expect(rects.a.height + GAP + rects.b.height + 2 * MARGIN).toBe(600)
    expect(rects.a.height).toBeLessThan(rects.b.height)
    expect(rects.divider.y).toBe(rects.a.y + rects.a.height)
    expect(rects.a.width).toBe(1000 - 2 * MARGIN)
  })

  it('never lets a pane be smaller than the clamp allows', () => {
    const small = paneRects(AREA, 'row', 0.01)
    const large = paneRects(AREA, 'row', 0.99)
    expect(small?.a.width).toBe(Math.round((1000 - 2 * MARGIN - GAP) * MIN_RATIO))
    expect(large?.b.width).toBe(1000 - 2 * MARGIN - GAP - Math.round((1000 - 2 * MARGIN - GAP) * MAX_RATIO))
  })

  it('has no split for an area too small to give each pane its minimum', () => {
    expect(paneRects({ x: 0, y: 0, width: 2 * MIN_PANE_PX + 2 * MARGIN + GAP - 1, height: 600 }, 'row', 0.5)).toBeNull()
    expect(paneRects({ x: 0, y: 0, width: 2 * MIN_PANE_PX + 2 * MARGIN + GAP, height: 600 }, 'row', 0.5)).not.toBeNull()
    expect(paneRects({ x: 0, y: 0, width: 1000, height: 300 }, 'column', 0.5)).toBeNull()
  })

  it('never puts one pane over the other, at any ratio', () => {
    for (let ratio = 0; ratio <= 1; ratio += 0.05) {
      const rects = paneRects(AREA, 'row', ratio)
      if (rects === null) throw new Error('expected room')
      expect(rects.a.x + rects.a.width + GAP).toBe(rects.b.x)
    }
  })
})

describe('ratioAt', () => {
  it('turns where the divider is dragged to into the ratio that puts it there', () => {
    const rects = paneRects(AREA, 'row', 0.3)
    if (rects === null) throw new Error('expected room')
    const centre = rects.divider.x + rects.divider.width / 2
    expect(ratioAt(AREA, 'row', centre)).toBeCloseTo(0.3, 2)
    expect(ratioAt(AREA, 'row', -500)).toBe(MIN_RATIO)
    expect(ratioAt(AREA, 'row', 5000)).toBe(MAX_RATIO)
  })

  it('reads a column from the pointer\'s height', () => {
    const rects = paneRects(AREA, 'column', 0.6)
    if (rects === null) throw new Error('expected room')
    expect(ratioAt(AREA, 'column', rects.divider.y + rects.divider.height / 2)).toBeCloseTo(0.6, 2)
  })

  it('is even when there is no room to measure', () => {
    expect(ratioAt({ x: 0, y: 0, width: 4, height: 4 }, 'row', 2)).toBe(0.5)
  })
})

describe('zoneAt', () => {
  it('names the edge a pointer is near, and none in the middle or outside', () => {
    expect(zoneAt(AREA, { x: 20, y: 400 })).toBe('left')
    expect(zoneAt(AREA, { x: 980, y: 400 })).toBe('right')
    expect(zoneAt(AREA, { x: 500, y: 110 })).toBe('top')
    expect(zoneAt(AREA, { x: 500, y: 690 })).toBe('bottom')
    expect(zoneAt(AREA, { x: 500, y: 400 })).toBeNull()
    expect(zoneAt(AREA, { x: -1, y: 400 })).toBeNull()
    expect(zoneAt(AREA, { x: 500, y: 700 })).toBeNull()
  })

  it('gives a corner to the edge it is nearer', () => {
    expect(zoneAt(AREA, { x: 10, y: 300 })).toBe('left')
    expect(zoneAt(AREA, { x: 100, y: 105 })).toBe('top')
  })
})

describe('zones', () => {
  it('halves the area on the side named', () => {
    expect(zoneHalf(AREA, 'left')).toEqual({ x: 0, y: 100, width: 500, height: 600 })
    expect(zoneHalf(AREA, 'right')).toEqual({ x: 500, y: 100, width: 500, height: 600 })
    expect(zoneHalf(AREA, 'top')).toEqual({ x: 0, y: 100, width: 1000, height: 300 })
    expect(zoneHalf(AREA, 'bottom')).toEqual({ x: 0, y: 400, width: 1000, height: 300 })
  })

  it('says which way the panes run and which one a dropped tab is', () => {
    expect(orientationOf('left')).toBe('row')
    expect(orientationOf('right')).toBe('row')
    expect(orientationOf('top')).toBe('column')
    expect(orientationOf('bottom')).toBe('column')
    expect(isFirstPane('left')).toBe(true)
    expect(isFirstPane('top')).toBe(true)
    expect(isFirstPane('right')).toBe(false)
    expect(isFirstPane('bottom')).toBe(false)
  })

  it('keeps a ratio within what a pane can be', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(MAX_RATIO)
    expect(clampRatio(0.5)).toBe(0.5)
  })
})

describe('SplitGroups', () => {
  it('joins two tabs, each finds the other, and a tab is in one group only', () => {
    const groups = new SplitGroups()
    expect(groups.create('a', 'b')).toBe(true)
    expect(groups.partnerOf('a')).toBe('b')
    expect(groups.partnerOf('b')).toBe('a')
    expect(groups.partnerOf('c')).toBeNull()
    expect(groups.create('b', 'c')).toBe(false)
    expect(groups.create('c', 'a')).toBe(false)
    expect(groups.create('c', 'c')).toBe(false)
  })

  it('breaks up from either tab, leaving both free to join others', () => {
    const groups = new SplitGroups()
    groups.create('a', 'b')
    groups.separate('b')
    expect(groups.partnerOf('a')).toBeNull()
    expect(groups.create('a', 'c')).toBe(true)
    groups.separate('nothing')
    expect(groups.partnerOf('a')).toBe('c')
  })

  it('trades the panes, turns them, and takes a ratio only within limits', () => {
    const groups = new SplitGroups()
    groups.create('a', 'b', 'row', 0.5)
    groups.swap('a')
    expect(groups.groupOf('a')).toMatchObject({ a: 'b', b: 'a' })
    groups.rotate('b')
    expect(groups.groupOf('a')?.orientation).toBe('column')
    groups.setRatio('a', 2)
    expect(groups.groupOf('a')?.ratio).toBe(MAX_RATIO)
    groups.setRatio('a', Number.NaN)
    expect(groups.groupOf('a')?.ratio).toBe(MAX_RATIO)
  })
})
