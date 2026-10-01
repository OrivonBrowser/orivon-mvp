import { describe, expect, it } from 'vitest'
import { TYPED_WITHIN_MS, isPrintableKey, keyIntent, wasTyped } from '../chrome/address-suggest-model.js'
import type { KeyLike } from '../chrome/address-suggest-model.js'

const key = (name: string, more: Partial<KeyLike> = {}): KeyLike => ({ key: name, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...more })
const open = (selected = 0): { open: boolean, selected: number } => ({ open: true, selected })
const closed = { open: false, selected: 0 }

describe('keyIntent', () => {
  it('moves the selection with the arrows while the rows are showing, and leaves the keys to the field otherwise', () => {
    expect(keyIntent(key('ArrowDown'), open())).toEqual({ type: 'move', step: 1 })
    expect(keyIntent(key('ArrowUp'), open())).toEqual({ type: 'move', step: -1 })
    expect(keyIntent(key('ArrowDown'), closed)).toBeNull()
  })

  it('leaves an arrow with a modifier to the field', () => {
    expect(keyIntent(key('ArrowDown', { shiftKey: true }), open())).toBeNull()
    expect(keyIntent(key('ArrowUp', { ctrlKey: true }), open())).toBeNull()
  })

  it('leaves Enter on the first row to the form, and takes it on any other row', () => {
    expect(keyIntent(key('Enter'), open(0))).toBeNull()
    expect(keyIntent(key('Enter'), open(3))).toEqual({ type: 'pick', disposition: 'current' })
    expect(keyIntent(key('Enter'), closed)).toBeNull()
  })

  it('opens the row in a new tab on Alt+Enter, the first row included', () => {
    expect(keyIntent(key('Enter', { altKey: true }), open(0))).toEqual({ type: 'pick', disposition: 'tab' })
    expect(keyIntent(key('Enter', { altKey: true }), closed)).toBeNull()
    expect(keyIntent(key('Enter', { altKey: true, ctrlKey: true }), open(2))).toBeNull()
  })

  it('takes no key while an input method is composing', () => {
    expect(keyIntent(key('Enter', { isComposing: true }), open(2))).toBeNull()
    expect(keyIntent(key('ArrowDown', { isComposing: true }), open())).toBeNull()
  })

  it('answers Escape whether or not the rows are showing, and never Escape with a modifier', () => {
    expect(keyIntent(key('Escape'), open())).toEqual({ type: 'escape' })
    expect(keyIntent(key('Escape'), closed)).toEqual({ type: 'escape' })
    expect(keyIntent(key('Escape', { shiftKey: true }), open())).toBeNull()
  })

  it('has no opinion on other keys', () => {
    expect(keyIntent(key('a'), open())).toBeNull()
    expect(keyIntent(key('Backspace'), open())).toBeNull()
    expect(keyIntent(key('ArrowRight'), open())).toBeNull()
  })
})

describe('isPrintableKey', () => {
  it('is true for a character and false for a chord or a named key', () => {
    expect(isPrintableKey(key('l'))).toBe(true)
    expect(isPrintableKey(key('L', { shiftKey: true }))).toBe(true)
    expect(isPrintableKey(key('v', { ctrlKey: true }))).toBe(false)
    expect(isPrintableKey(key('v', { metaKey: true }))).toBe(false)
    expect(isPrintableKey(key('Enter'))).toBe(false)
  })
})

describe('wasTyped', () => {
  const field = { value: 'loc', selectionStart: 3, selectionEnd: 3 }
  const typed = { inputType: 'insertText', isComposing: false }
  const NOW = 10_000

  it('is true for a character just typed at the end of the text', () => {
    expect(wasTyped(typed, field, NOW - 5, NOW)).toBe(true)
  })

  it('is false for a fill or a paste, which no printable key came before', () => {
    expect(wasTyped(typed, field, 0, NOW)).toBe(false)
    expect(wasTyped({ inputType: 'insertFromPaste', isComposing: false }, field, NOW - 5, NOW)).toBe(false)
  })

  it('is false after a key older than the window, and true at its edge', () => {
    expect(wasTyped(typed, field, NOW - TYPED_WITHIN_MS - 1, NOW)).toBe(false)
    expect(wasTyped(typed, field, NOW - TYPED_WITHIN_MS, NOW)).toBe(true)
  })

  it.each(['deleteContentBackward', 'deleteContentForward', 'insertCompositionText', 'historyUndo', 'insertFromDrop'])('is false for %s', (inputType) => {
    expect(wasTyped({ inputType, isComposing: false }, field, NOW, NOW)).toBe(false)
  })

  it('is false while composing, in the middle of the text, and over a selection', () => {
    expect(wasTyped({ inputType: 'insertText', isComposing: true }, field, NOW, NOW)).toBe(false)
    expect(wasTyped(typed, { ...field, selectionStart: 1, selectionEnd: 1 }, NOW, NOW)).toBe(false)
    expect(wasTyped(typed, { ...field, selectionStart: 1, selectionEnd: 3 }, NOW, NOW)).toBe(false)
  })
})
