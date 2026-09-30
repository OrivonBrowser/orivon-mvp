import { describe, expect, it } from 'vitest'
import { chooserFrom, DOTS, selectionFrom, stepFor } from '../model.js'

describe('chooserFrom', () => {
  it('reads the rows and the generated password of a show', () => {
    expect(chooserFrom({ logins: [{ id: 'a', username: 'ada' }, { id: 'b', username: '' }], generated: 'Xy-12' })).toEqual({
      logins: [{ id: 'a', username: 'ada' }, { id: 'b', username: '' }], generated: 'Xy-12', mode: 'button'
    })
  })

  it('drops a row that is not an id and a username, and an empty or non-string generated value', () => {
    expect(chooserFrom({ logins: [{ id: 1, username: 'x' }, null, 'row', { id: 'a' }, { username: 'u' }, { id: 'ok', username: 'fine' }], generated: '' }))
      .toEqual({ logins: [{ id: 'ok', username: 'fine' }], generated: null, mode: 'button' })
    expect(chooserFrom({ logins: [], generated: 7 }).generated).toBeNull()
  })

  it('reads anything else as an empty chooser', () => {
    for (const payload of [undefined, null, 'x', 4, [], { logins: 'no' }]) expect(chooserFrom(payload)).toEqual({ logins: [], generated: null, mode: 'button' })
  })
})

describe('the mode', () => {
  it('is the one under a box only when main says so', () => {
    expect(chooserFrom({ logins: [], generated: null, mode: 'field' }).mode).toBe('field')
    for (const mode of ['button', 'other', 7, undefined]) expect(chooserFrom({ mode }).mode).toBe('button')
  })
})

describe('selectionFrom', () => {
  it('reads a select event inside the list, and -1 for none', () => {
    expect(selectionFrom({ type: 'select', index: 0 }, 3)).toBe(0)
    expect(selectionFrom({ type: 'select', index: 2 }, 3)).toBe(2)
    expect(selectionFrom({ type: 'select', index: -1 }, 3)).toBe(-1)
  })

  it('refuses an index outside the list, a fraction, and anything that is not a select event', () => {
    for (const event of [{ type: 'select', index: 3 }, { type: 'select', index: -2 }, { type: 'select', index: 1.5 }, { type: 'select', index: '1' }, { type: 'move', index: 1 }, null, 'select', undefined]) expect(selectionFrom(event, 3)).toBeNull()
  })
})

describe('stepFor', () => {
  it('maps the list keys and nothing else', () => {
    expect(stepFor('ArrowDown')).toBe('down')
    expect(stepFor('ArrowUp')).toBe('up')
    expect(stepFor('Home')).toBe('first')
    expect(stepFor('End')).toBe('last')
    for (const key of ['Enter', 'Tab', 'a', 'PageDown', '']) expect(stepFor(key)).toBeNull()
  })
})

describe('DOTS', () => {
  it('is eight bullets, the same for every row', () => {
    expect(DOTS).toHaveLength(8)
    expect(new Set(DOTS).size).toBe(1)
  })
})
