import { describe, expect, it } from 'vitest'
import { isFindChord } from '../find-chord.js'

const key = (overrides: Record<string, unknown> = {}): Parameters<typeof isFindChord>[0] =>
  ({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, ...overrides })

describe('isFindChord', () => {
  it('is Ctrl+F off macOS and Cmd+F on macOS', () => {
    expect(isFindChord(key(), 'linux')).toBe(true)
    expect(isFindChord(key(), 'win32')).toBe(true)
    expect(isFindChord(key({ ctrlKey: false, metaKey: true }), 'darwin')).toBe(true)
    expect(isFindChord(key({ ctrlKey: false, metaKey: true }), 'linux')).toBe(false)
    expect(isFindChord(key(), 'darwin')).toBe(false)
  })

  it('reads the letter either case, as a held Caps Lock changes it', () => {
    expect(isFindChord(key({ key: 'F' }), 'linux')).toBe(true)
  })

  it.each([
    ['another letter', { key: 'g' }],
    ['an added Shift', { shiftKey: true }],
    ['an added Alt', { altKey: true }],
    ['an input method composing', { isComposing: true }],
    ['a held key repeating', { repeat: true }]
  ])('is not %s', (_label, overrides) => {
    expect(isFindChord(key(overrides), 'linux')).toBe(false)
  })
})
