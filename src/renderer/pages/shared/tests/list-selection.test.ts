import { describe, expect, it } from 'vitest'
import { all, focusAfterRemoval, keepShown, range, step, toggle } from '../list-selection.js'

const IDS = [10, 20, 30, 40, 50]

describe('list selection', () => {
  it('toggles a row in and out without changing the set it was given', () => {
    const first = new Set([10])
    expect([...toggle(first, 20)]).toEqual([10, 20])
    expect([...toggle(first, 10)]).toEqual([])
    expect([...first]).toEqual([10])
  })

  it('takes every row from the anchor to the target, whichever is higher', () => {
    expect([...range(IDS, 20, 40)]).toEqual([20, 30, 40])
    expect([...range(IDS, 40, 20)]).toEqual([20, 30, 40])
    expect([...range(IDS, 30, 30)]).toEqual([30])
  })

  it('takes the target alone when there is no anchor or it has left the list, and nothing for a target that is gone', () => {
    expect([...range(IDS, null, 30)]).toEqual([30])
    expect([...range(IDS, 99, 30)]).toEqual([30])
    expect([...range(IDS, 10, 99)]).toEqual([])
  })

  it('selects all, and keeps only what is still shown', () => {
    expect([...all(IDS)]).toEqual(IDS)
    expect([...keepShown(new Set([10, 99, 50]), IDS)]).toEqual([10, 50])
  })

  it('steps the focus and holds at the ends', () => {
    expect(step(IDS, 30, 'down')).toBe(40)
    expect(step(IDS, 30, 'up')).toBe(20)
    expect(step(IDS, 50, 'down')).toBe(50)
    expect(step(IDS, 10, 'up')).toBe(10)
    expect(step(IDS, 30, 'first')).toBe(10)
    expect(step(IDS, 30, 'last')).toBe(50)
    expect(step(IDS, null, 'down')).toBe(10)
    expect(step([], 10, 'down')).toBeNull()
  })

  it('moves the focus to the next row after a delete, else the one before, else nowhere', () => {
    expect(focusAfterRemoval(IDS, new Set([30]), 30)).toBe(40)
    expect(focusAfterRemoval(IDS, new Set([40, 50]), 50)).toBe(30)
    expect(focusAfterRemoval(IDS, new Set([50]), 50)).toBe(40)
    expect(focusAfterRemoval(IDS, new Set([20, 30]), 20)).toBe(40)
    expect(focusAfterRemoval(IDS, new Set(IDS), 10)).toBeNull()
    expect(focusAfterRemoval(IDS, new Set([20]), null)).toBe(10)
  })
})
