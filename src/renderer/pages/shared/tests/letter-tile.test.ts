import { describe, expect, it } from 'vitest'
import { initialOf } from '../letter-tile.js'

describe('initialOf', () => {
  it('takes the first letter of the name, upper case', () => {
    expect(initialOf('orivon tabs')).toBe('O')
    expect(initialOf('  uBlock')).toBe('U')
  })

  it('keeps a whole character that is outside the basic plane', () => {
    expect(initialOf('\u{1F9E9} Puzzle')).toBe('\u{1F9E9}')
  })

  it('falls back to a question mark for an empty name', () => {
    expect(initialOf('   ')).toBe('?')
  })
})
