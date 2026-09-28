import { describe, expect, it } from 'vitest'
import { chordFromInput, chordId, displayKeys, formatBinding, matches, parseBinding } from '../accelerator.js'
import type { KeyInput } from '../accelerator.js'

const input = (key: string, code: string, mods: Partial<Pick<KeyInput, 'control' | 'alt' | 'shift' | 'meta'>> = {}): KeyInput =>
  ({ key, code, control: false, alt: false, shift: false, meta: false, ...mods })

describe('chordFromInput', () => {
  it('reads a letter with its modifiers, whatever the case the key reports', () => {
    expect(chordFromInput(input('T', 'KeyT', { control: true, shift: true }))).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 't' })
    expect(chordFromInput(input('t', 'KeyT', { control: true }))?.key).toBe('t')
  })

  it('reads a digit by its key, not by the symbol a layout types for it', () => {
    // A French layout types "&" for the unshifted 1 key.
    expect(chordFromInput(input('&', 'Digit1', { control: true }))?.key).toBe('1')
    expect(chordFromInput(input('1', 'Digit1', { control: true }))?.key).toBe('1')
  })

  it('reads a letter of another alphabet as the Latin letter on its key', () => {
    expect(chordFromInput(input('е', 'KeyT', { control: true }))?.key).toBe('t')
    expect(chordFromInput(input('т', 'KeyN', { control: true }))?.key).toBe('n')
  })

  it('does not read what AltGr typed as a chord: Windows reports it as Control and Alt together', () => {
    // Polish ó, ś and ź, on the keys that carry O, S and X in Latin.
    for (const [key, code] of [['ó', 'KeyO'], ['ś', 'KeyS'], ['ź', 'KeyX'], ['@', 'KeyQ'], ['²', 'Digit2']] as const) {
      expect(chordFromInput(input(key, code, { control: true, alt: true })), key).toBeNull()
    }
    // Control alone, or Alt alone, still reads the key underneath, and a plain key with both still reads.
    expect(chordFromInput(input('ó', 'KeyO', { control: true }))?.key).toBe('o')
    expect(chordFromInput(input('ó', 'KeyO', { alt: true }))?.key).toBe('o')
    expect(chordFromInput(input('o', 'KeyO', { control: true, alt: true }))).toMatchObject({ ctrl: true, alt: true, key: 'o' })
    expect(chordFromInput(input('1', 'Digit1', { control: true, alt: true }))).toMatchObject({ ctrl: true, alt: true, key: '1' })
  })

  it.each([
    ['Tab', 'Tab'], ['Escape', 'Escape'], [' ', 'Space'], ['ArrowLeft', 'Left'], ['PageDown', 'PageDown'], ['Delete', 'Delete']
  ])('names %j as %s', (key, name) => {
    expect(chordFromInput(input(key, key))?.key).toBe(name)
  })

  it('reads function keys and punctuation', () => {
    expect(chordFromInput(input('F12', 'F12'))?.key).toBe('F12')
    expect(chordFromInput(input('=', 'Equal', { control: true }))?.key).toBe('=')
    expect(chordFromInput(input('+', 'Equal', { control: true, shift: true }))).toMatchObject({ key: '+', shift: true })
    expect(chordFromInput(input(',', 'Comma', { control: true }))?.key).toBe(',')
  })

  it.each(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])('is nothing for the modifier %s alone', (key) => {
    expect(chordFromInput(input(key, key))).toBeNull()
  })

  it.each([['Dead', 'Quote'], ['Unidentified', ''], ['MediaPlayPause', 'MediaPlayPause'], ['F25', 'F25'], ['ß', 'Minus']])('is nothing for a key no binding can name: %j', (key, code) => {
    expect(chordFromInput(input(key, code))).toBeNull()
  })
})

describe('parseBinding and formatBinding', () => {
  it('reads Mod as control on Linux and Windows, and as command on macOS', () => {
    expect(parseBinding('Mod+Shift+T', 'linux')).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 't' })
    expect(parseBinding('Mod+Shift+T', 'win32')?.ctrl).toBe(true)
    expect(parseBinding('Mod+Shift+T', 'darwin')).toEqual({ ctrl: false, alt: false, shift: true, meta: true, key: 't' })
  })

  it('reads a bare key, a named key, and the plus key', () => {
    expect(parseBinding('F12', 'linux')).toEqual({ ctrl: false, alt: false, shift: false, meta: false, key: 'F12' })
    expect(parseBinding('Alt+Left', 'linux')?.key).toBe('Left')
    expect(parseBinding('Mod++', 'linux')).toMatchObject({ ctrl: true, key: '+' })
    expect(parseBinding('Mod+=', 'linux')).toMatchObject({ ctrl: true, key: '=' })
  })

  it.each(['', 'Mod+', 'Mod+Mod+T', 'Cmd+T', 'Mod+Shift', 'Mod+TT', 'Mod+F25', 'Hyper+T', 'mod+t+u'])('refuses %j', (text) => {
    expect(parseBinding(text, 'linux')).toBeNull()
  })

  it('reads a lone plus as the plus key: whether a binding is allowed is the rules\' business, not the parser\'s', () => {
    expect(parseBinding('+', 'linux')).toMatchObject({ key: '+', ctrl: false })
  })

  it('writes down what it read, for the platform it was read on', () => {
    for (const text of ['Mod+Shift+T', 'Ctrl+Tab', 'Alt+Left', 'F12', 'Mod++', 'Mod+1', 'Mod+,', 'Ctrl+Alt+Shift+Delete']) {
      for (const platform of ['linux', 'darwin'] as const) {
        const chord = parseBinding(text, platform)
        expect(chord, text).not.toBeNull()
        expect(parseBinding(formatBinding(chord as never, platform), platform), text).toEqual(chord)
      }
    }
  })

  it('writes control on macOS as Ctrl, not as the platform modifier', () => {
    expect(formatBinding(parseBinding('Ctrl+Tab', 'darwin') as never, 'darwin')).toBe('Ctrl+Tab')
  })
})

describe('displayKeys', () => {
  it('names the keys a person presses', () => {
    expect(displayKeys(parseBinding('Mod+Shift+T', 'linux') as never, 'linux')).toEqual(['Ctrl', 'Shift', 'T'])
    expect(displayKeys(parseBinding('Mod+Shift+T', 'darwin') as never, 'darwin')).toEqual(['Shift', 'Cmd', 'T'])
    expect(displayKeys(parseBinding('Alt+Left', 'darwin') as never, 'darwin')).toEqual(['Option', 'Left'])
  })
})

describe('matches', () => {
  it('needs the same key and the same modifiers', () => {
    const binding = parseBinding('Mod+Shift+T', 'linux') as never
    expect(matches(chordFromInput(input('T', 'KeyT', { control: true, shift: true })) as never, binding)).toBe(true)
    expect(matches(chordFromInput(input('t', 'KeyT', { control: true })) as never, binding)).toBe(false)
    expect(matches(chordFromInput(input('T', 'KeyT', { control: true, shift: true, alt: true })) as never, binding)).toBe(false)
    expect(matches(chordFromInput(input('n', 'KeyN', { control: true, shift: true })) as never, binding)).toBe(false)
  })

  it('does not care about Shift for a symbol layouts type with and without it', () => {
    const zoomIn = parseBinding('Mod++', 'linux') as never
    expect(matches(chordFromInput(input('+', 'Equal', { control: true, shift: true })) as never, zoomIn)).toBe(true)
    expect(matches(chordFromInput(input('+', 'BracketRight', { control: true })) as never, zoomIn)).toBe(true)
  })
})

describe('chordId', () => {
  it('is the same for chords that are the same and different otherwise', () => {
    const a = parseBinding('Mod+Shift+T', 'linux') as never
    expect(chordId(a)).toBe(chordId(parseBinding('Shift+Mod+T', 'linux') as never))
    expect(chordId(a)).not.toBe(chordId(parseBinding('Mod+T', 'linux') as never))
  })
})
