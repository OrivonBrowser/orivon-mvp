// How a spec turns a binding into the key events and the text of one platform: no Electron is launched.
import { describe, expect, it } from 'vitest'
import { bindingOf, keyCapsOf, keyCodeOf, modifiersOf, shownBinding } from './key-bindings.js'

describe('bindingOf', () => {
  it('gives a command its macOS binding on macOS and its default elsewhere', () => {
    expect(bindingOf('nav.home', 'darwin')).toBe('Mod+Shift+H')
    expect(bindingOf('nav.home', 'linux')).toBe('Alt+Home')
    expect(bindingOf('devtools.toggle', 'darwin')).toBe('Mod+Alt+I')
    expect(bindingOf('devtools.toggle', 'win32')).toBe('F12')
    expect(bindingOf('tab.new', 'darwin')).toBe('Mod+T')
  })

  it('refuses a command nobody bound', () => {
    expect(() => bindingOf('tab.pin', 'linux')).toThrow(/no default binding/)
  })
})

describe('modifiersOf and keyCodeOf', () => {
  it('holds Command for Mod on macOS and Control elsewhere', () => {
    expect(modifiersOf('Mod+Shift+O', 'darwin')).toEqual(['meta', 'shift'])
    expect(modifiersOf('Mod+Shift+O', 'linux')).toEqual(['control', 'shift'])
    expect(modifiersOf('Mod+Shift+O', 'win32')).toEqual(['control', 'shift'])
  })

  it('holds Control for a literal Ctrl on every system, and names every modifier', () => {
    expect(modifiersOf('Ctrl+Tab', 'darwin')).toEqual(['control'])
    expect(modifiersOf('Ctrl+Meta+F', 'darwin')).toEqual(['control', 'meta'])
    expect(modifiersOf('Mod+Alt+B', 'darwin')).toEqual(['meta', 'alt'])
    expect(modifiersOf('F12', 'darwin')).toEqual([])
  })

  it('names the key the way Electron does', () => {
    expect(keyCodeOf('Mod+Shift+t')).toBe('T')
    expect(keyCodeOf('Mod+=')).toBe('=')
    expect(keyCodeOf('Mod+[')).toBe('[')
    expect(keyCodeOf('Mod+9')).toBe('9')
    expect(keyCodeOf('Ctrl+Shift+Tab')).toBe('Tab')
    expect(keyCodeOf('Mod+Shift+PageUp')).toBe('PageUp')
    expect(keyCodeOf('Mod+Shift+Delete')).toBe('Delete')
    expect(keyCodeOf('F12')).toBe('F12')
  })

  it('refuses text that is not a binding', () => {
    expect(() => modifiersOf('Mod+Shift+', 'linux')).toThrow(/not a binding/)
  })
})

describe('shownBinding', () => {
  it('writes the keys out elsewhere and as symbols on macOS', () => {
    expect(shownBinding('Mod+T', 'linux')).toBe('Ctrl+T')
    expect(shownBinding('Mod+Shift+T', 'linux')).toBe('Ctrl+Shift+T')
    expect(shownBinding('Alt+Home', 'linux')).toBe('Alt+Home')
    expect(shownBinding('Mod+T', 'darwin')).toBe('⌘T')
    expect(shownBinding('Mod+Shift+H', 'darwin')).toBe('⇧⌘H')
    expect(shownBinding('Mod+,', 'win32')).toBe('Ctrl+,')
  })
})

describe('keyCapsOf', () => {
  it('lists the key caps in the order Settings shows them', () => {
    expect(keyCapsOf('Mod+Alt+Y', 'linux')).toEqual(['Ctrl', 'Alt', 'Y'])
    expect(keyCapsOf('Mod+Alt+Y', 'darwin')).toEqual(['Option', 'Cmd', 'Y'])
    expect(keyCapsOf('Ctrl+Tab', 'darwin')).toEqual(['Ctrl', 'Tab'])
  })
})
