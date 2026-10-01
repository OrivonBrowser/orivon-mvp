import { describe, expect, it } from 'vitest'
import { asPayload, jumpTo, rowLabel, siteLine, stepControl } from '../overlay/extensions-menu/model.js'
import { MORE_ITEMS } from '../overlay/extensions-menu/more-items.js'

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'a'.repeat(32), name: 'Alpha', icon: null, pinned: true, hasAction: true, hasOptions: false, badge: '', parts: {}, ...extra })

describe('asPayload', () => {
  it('reads the rows, the site and whether anything can run here', () => {
    expect(asPayload({ site: 'example.com', activatable: false, rows: [row()] })).toEqual({ site: 'example.com', activatable: false, rows: [row()] })
  })

  it('takes an unset site as none and an unset flag as true', () => {
    expect(asPayload({ rows: [] })).toEqual({ site: null, activatable: true, rows: [] })
  })

  it('drops a row that is not what main builds, and refuses a value that is not a menu', () => {
    expect(asPayload({ rows: [row(), { id: 3 }, null, 'x', row({ pinned: 'yes' })] })?.rows).toHaveLength(1)
    for (const bad of [undefined, null, 'menu', 4, [], {}, { rows: 'x' }]) expect(asPayload(bad)).toBeUndefined()
  })
})

describe('stepControl', () => {
  it('moves along a row and stops at its ends', () => {
    expect(stepControl(3, 0, 1)).toBe(1)
    expect(stepControl(3, 1, 1)).toBe(2)
    expect(stepControl(3, 2, 1)).toBe(2)
    expect(stepControl(3, 0, -1)).toBe(0)
    expect(stepControl(2, 1, -1)).toBe(0)
  })
})

describe('jumpTo', () => {
  const names = ['Alpha', 'beta', 'Bravo', 'Gamma']

  it('goes to the next name after the current one that starts with the letter, either case', () => {
    expect(jumpTo(names, 0, 'b')).toBe(1)
    expect(jumpTo(names, 1, 'B')).toBe(2)
  })

  it('wraps round, and reaches the current row only when it is the one that matches', () => {
    expect(jumpTo(names, 2, 'b')).toBe(1)
    expect(jumpTo(names, 3, 'g')).toBe(3)
    expect(jumpTo(names, 0, 'a')).toBe(0)
  })

  it('starts from the first row when none is focused, and finds nothing for a letter no name has or for a key that is no letter', () => {
    expect(jumpTo(names, -1, 'a')).toBe(0)
    expect(jumpTo(names, 0, 'z')).toBe(-1)
    expect(jumpTo(names, 0, 'Enter')).toBe(-1)
    expect(jumpTo([], 0, 'a')).toBe(-1)
  })
})

describe('the heading and the label', () => {
  it('says "on" the site, or nothing', () => {
    expect(siteLine('example.com')).toBe('on example.com')
    expect(siteLine(null)).toBe('')
  })

  it('adds the badge to a row\'s name', () => {
    expect(rowLabel(row() as never)).toBe('Alpha')
    expect(rowLabel(row({ badge: '3' }) as never)).toBe('Alpha, 3')
  })
})

describe('MORE_ITEMS', () => {
  it('has each order once, with options, pin, manage and remove from 40 to 70', () => {
    const orders = MORE_ITEMS.map((item) => item.order)
    expect(new Set(orders).size).toBe(orders.length)
    expect([...orders].sort((a, b) => a - b)).toEqual([40, 50, 60, 70])
  })
})
