import { describe, expect, it } from 'vitest'
import { clearOfPairs, moveInOrder } from '../tab-order.js'

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

describe('a joined pair', () => {
  const pairs = [['b', 'c'] as const]

  it('is passed, not entered, by a tab moved into it from either side', () => {
    const fromLeft = ['a', 'b', 'c', 'd']
    moveInOrder(fromLeft, 'a', 1, pairs)
    expect(fromLeft).toEqual(['b', 'c', 'a', 'd'])

    const fromRight = ['a', 'b', 'c', 'd']
    moveInOrder(fromRight, 'd', 1, pairs)
    expect(fromRight).toEqual(['a', 'd', 'b', 'c'])
  })

  it('does not stop a tab that stops outside it', () => {
    const order = ['a', 'b', 'c', 'd']
    moveInOrder(order, 'a', 3, pairs)
    expect(order).toEqual(['b', 'c', 'd', 'a'])
  })

  it('sends a tab arriving from elsewhere to the far side of the pair', () => {
    expect(clearOfPairs(['a', 'b', 'c', 'd'], 2, pairs, -1)).toBe(3)
    expect(clearOfPairs(['a', 'b', 'c', 'd'], 1, pairs, -1)).toBe(1)
  })
})
