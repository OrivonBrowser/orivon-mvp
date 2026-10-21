import { describe, expect, it } from 'vitest'
import { bookmarkKey } from '../view-list.js'

describe('bookmarkKey', () => {
  it('writes the shortcut the way each system shows it', () => {
    expect(bookmarkKey('darwin')).toBe('⌘D')
    expect(bookmarkKey('linux')).toBe('Ctrl+D')
    expect(bookmarkKey('win32')).toBe('Ctrl+D')
  })
})
