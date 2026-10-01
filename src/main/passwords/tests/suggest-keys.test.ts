import { describe, expect, it } from 'vitest'
import { SUGGEST_KEYS, suggestKey } from '../suggest-keys.js'

describe('suggestKey', () => {
  it('Down chooses the first row, then each next one, and stays on the last', () => {
    expect(suggestKey(3, -1, 'ArrowDown')).toEqual({ selected: 0, action: 'move' })
    expect(suggestKey(3, 0, 'ArrowDown')).toEqual({ selected: 1, action: 'move' })
    expect(suggestKey(3, 2, 'ArrowDown')).toEqual({ selected: 2, action: 'move' })
  })

  it('Up chooses the last row from none, then each one before, and stays on the first', () => {
    expect(suggestKey(3, -1, 'ArrowUp')).toEqual({ selected: 2, action: 'move' })
    expect(suggestKey(3, 2, 'ArrowUp')).toEqual({ selected: 1, action: 'move' })
    expect(suggestKey(3, 0, 'ArrowUp')).toEqual({ selected: 0, action: 'move' })
  })

  it('Enter belongs to the page until a row is chosen', () => {
    expect(suggestKey(3, -1, 'Enter')).toEqual({ selected: -1, action: 'pass' })
    expect(suggestKey(3, 1, 'Enter')).toEqual({ selected: 1, action: 'choose' })
  })

  it('Escape dismisses', () => {
    expect(suggestKey(3, -1, 'Escape').action).toBe('dismiss')
    expect(suggestKey(3, 2, 'Escape').action).toBe('dismiss')
  })

  it('every other key is the page\'s, and an empty list takes none', () => {
    for (const key of ['a', 'Tab', 'Backspace', 'Home', 'End', ' ']) expect(suggestKey(3, 1, key)).toEqual({ selected: 1, action: 'pass' })
    for (const key of ['ArrowDown', 'Enter', 'Escape']) expect(suggestKey(0, -1, key).action).toBe('pass')
  })

  it('names the four keys it may take', () => {
    expect([...SUGGEST_KEYS].sort()).toEqual(['ArrowDown', 'ArrowUp', 'Enter', 'Escape'])
  })
})
