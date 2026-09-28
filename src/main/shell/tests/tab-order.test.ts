import { describe, expect, it } from 'vitest'
import { moveInOrder } from '../tab-order.js'

describe('moveInOrder', () => {
  it('moves a tab to a place in the strip', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(moveInOrder(order, 'a', 2)).toBe(true)
    expect(order).toEqual(['b', 'c', 'a', 'd'])
    expect(moveInOrder(order, 'd', 0)).toBe(true)
    expect(order).toEqual(['d', 'b', 'c', 'a'])
  })

  it('keeps a place past either end inside the strip', () => {
    const order = ['a', 'b', 'c']
    moveInOrder(order, 'a', 99)
    expect(order).toEqual(['b', 'c', 'a'])
    moveInOrder(order, 'a', -5)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('changes nothing for a tab that is not there, a place it already has, or a place that is not a number', () => {
    const order = ['a', 'b', 'c']
    expect(moveInOrder(order, 'x', 0)).toBe(false)
    expect(moveInOrder(order, 'b', 1)).toBe(false)
    expect(moveInOrder(order, 'b', Number.NaN)).toBe(false)
    expect(moveInOrder(order, 'b', Infinity)).toBe(false)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('takes a fractional place as the whole one below it', () => {
    const order = ['a', 'b', 'c']
    moveInOrder(order, 'a', 1.9)
    expect(order).toEqual(['b', 'a', 'c'])
  })
})
