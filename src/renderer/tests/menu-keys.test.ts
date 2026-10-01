import { describe, expect, it } from 'vitest'
import { formatKeys, nextRow } from '../overlay/menu/keys.js'

describe('formatKeys', () => {
  it('joins key caps with a plus off macOS', () => {
    expect(formatKeys(['Ctrl', 'Shift', 'T'], 'linux')).toBe('Ctrl+Shift+T')
    expect(formatKeys(['F12'], 'win32')).toBe('F12')
  })

  it('writes the symbols a Mac shows, run together', () => {
    expect(formatKeys(['Cmd', 'Shift', 'T'], 'darwin')).toBe('⌘⇧T')
    expect(formatKeys(['Option', 'Cmd', 'I'], 'darwin')).toBe('⌥⌘I')
    expect(formatKeys(['F12'], 'darwin')).toBe('F12')
  })
})

describe('nextRow', () => {
  it('moves down and up, wrapping at both ends', () => {
    expect(nextRow(4, 0, 'ArrowDown')).toBe(1)
    expect(nextRow(4, 3, 'ArrowDown')).toBe(0)
    expect(nextRow(4, 0, 'ArrowUp')).toBe(3)
    expect(nextRow(4, 2, 'ArrowUp')).toBe(1)
  })

  it('reaches the first row with Down and the last with Up from no row', () => {
    expect(nextRow(4, -1, 'ArrowDown')).toBe(0)
    expect(nextRow(4, -1, 'ArrowUp')).toBe(3)
  })

  it('jumps to the ends with Home and End, and finds nothing in an empty list', () => {
    expect(nextRow(4, 2, 'Home')).toBe(0)
    expect(nextRow(4, 1, 'End')).toBe(3)
    expect(nextRow(0, -1, 'ArrowDown')).toBe(-1)
  })
})
