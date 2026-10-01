import { describe, expect, it } from 'vitest'
import { isPinned, sortRows } from '../action-pins.js'

describe('isPinned', () => {
  it('follows the setting for an extension the person never chose for', () => {
    expect(isPinned({ pinned: null }, true)).toBe(true)
    expect(isPinned({ pinned: null }, false)).toBe(false)
  })

  it('takes the person\'s own choice over the setting, either way', () => {
    expect(isPinned({ pinned: false }, true)).toBe(false)
    expect(isPinned({ pinned: true }, false)).toBe(true)
  })
})

describe('sortRows', () => {
  const row = (name: string, pinned: boolean): { name: string, pinned: boolean } => ({ name, pinned })

  it('puts the pinned ones first, each group by name', () => {
    const sorted = sortRows([row('Zed', false), row('beta', true), row('Alpha', false), row('Gamma', true)])
    expect(sorted.map((entry) => entry.name)).toEqual(['beta', 'Gamma', 'Alpha', 'Zed'])
  })

  it('keeps the order two names that differ only in case came in, and does not change its input', () => {
    const input = [row('same', false), row('SAME', false), row('Same', false)]
    expect(sortRows(input)).toEqual(input)
    const copy = [row('b', false), row('a', true)]
    sortRows(copy)
    expect(copy.map((entry) => entry.name)).toEqual(['b', 'a'])
  })

  it('sorts nothing into nothing', () => {
    expect(sortRows([])).toEqual([])
  })
})
