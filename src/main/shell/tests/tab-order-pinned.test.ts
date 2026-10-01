import { describe, expect, it } from 'vitest'
import { clampToRun, moveInOrder, pinnedCount } from '../tab-order.js'

// The strip's three invariants, in one place: the pinned run leads it, a joined pair stays side by side, and a
// pinned tab is never in a pair.
const pinned = (...ids: string[]) => (id: string): boolean => ids.includes(id)

describe('pinnedCount and clampToRun', () => {
  it('counts the pinned tabs of a strip', () => {
    expect(pinnedCount(['a', 'b', 'c'], pinned('a', 'b'))).toBe(2)
    expect(pinnedCount([], pinned('a'))).toBe(0)
  })

  it.each([
    // index, pinned, run length, strip length, place
    [0, true, 2, 5, 0],
    [4, true, 2, 5, 2],
    [-3, true, 2, 5, 0],
    [0, false, 2, 5, 2],
    [1, false, 2, 5, 2],
    [3, false, 2, 5, 3],
    [9, false, 2, 5, 5],
    [0, false, 0, 4, 0],
    [3, true, 0, 4, 0]
  ])('a place %i for a pinned=%s tab, with %i pinned among %i others, is %i', (index, isPinned, count, length, place) => {
    expect(clampToRun(index, isPinned, count, length)).toBe(place)
  })
})

describe('moveInOrder with pinned tabs', () => {
  it('keeps a pinned tab among the pinned ones', () => {
    const order = ['a', 'b', 'c', 'd']
    moveInOrder(order, 'a', 3, [], pinned('a', 'b'))
    expect(order).toEqual(['b', 'a', 'c', 'd'])
  })

  it('keeps an unpinned tab out of the pinned run, in either direction', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(moveInOrder(order, 'd', 0, [], pinned('a', 'b'))).toBe(true)
    expect(order).toEqual(['a', 'b', 'd', 'c'])
    expect(moveInOrder(order, 'd', 1, [], pinned('a', 'b'))).toBe(false)
  })

  it('refuses a move across the boundary that would change nothing', () => {
    const order = ['a', 'b', 'c']
    expect(moveInOrder(order, 'c', 0, [], pinned('a'))).toBe(true)
    expect(order).toEqual(['a', 'c', 'b'])
  })

  it('leaves a strip with nothing pinned moving as it always did', () => {
    const order = ['a', 'b', 'c']
    moveInOrder(order, 'a', 99)
    expect(order).toEqual(['b', 'c', 'a'])
  })

  it('passes a pair that sits at the edge of the pinned run, not into it', () => {
    // a is pinned, then the pair (b, c), then d.
    const order = ['a', 'b', 'c', 'd']
    moveInOrder(order, 'd', 2, [['b', 'c']], pinned('a'))
    expect(order).toEqual(['a', 'd', 'b', 'c'])
    moveInOrder(order, 'd', 0, [['b', 'c']], pinned('a'))
    expect(order).toEqual(['a', 'd', 'b', 'c'])
  })
})
