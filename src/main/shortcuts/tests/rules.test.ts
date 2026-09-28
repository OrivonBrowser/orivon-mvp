import { describe, expect, it } from 'vitest'
import { parseBinding } from '../accelerator.js'
import { checkBinding } from '../rules.js'

const check = (text: string, platform: NodeJS.Platform = 'linux'): ReturnType<typeof checkBinding> => checkBinding(parseBinding(text, platform) as never, platform)

describe('checkBinding', () => {
  it.each(['Mod+Shift+T', 'Ctrl+Tab', 'Alt+Left', 'F12', 'Shift+F5', 'Mod+1', 'Mod+,', 'Ctrl+Alt+Delete'])('allows %s', (text) => {
    expect(check(text)).toBeNull()
  })

  it.each(['T', 'Shift+T', '1', 'Tab', 'Left', 'Escape', 'Space', ','])('needs a modifier for %s, since it types or navigates on its own', (text) => {
    expect(check(text)).toBe('needs-modifier')
  })

  it.each(['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+Q', 'Alt+F4'])('keeps %s for editing and quitting', (text) => {
    expect(check(text)).toBe('reserved')
    expect(check(text, 'darwin')).toBe('reserved')
  })

  it('reserves the editing keys of the platform they are on', () => {
    // Control+C is the copy key on Linux but only a chord on macOS.
    expect(check('Ctrl+C', 'linux')).toBe('reserved')
    expect(check('Ctrl+C', 'darwin')).toBeNull()
    expect(check('Meta+C', 'darwin')).toBe('reserved')
  })
})
