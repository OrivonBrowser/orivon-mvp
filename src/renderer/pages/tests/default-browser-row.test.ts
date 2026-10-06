import { describe, expect, it } from 'vitest'
import { linuxCommand, unavailableWords } from '../settings/sections/default-browser-row.js'

describe('the Default browser row\'s words', () => {
  it('tells a run from source on Linux how to become settable, and elsewhere to install Orivon', () => {
    expect(unavailableWords('source', 'linux')).toContain('node scripts/launch-from-source.mjs install')
    expect(unavailableWords('source', 'darwin')).toBe('Not available while Orivon runs from its source folder. Install Orivon to set it.')
    expect(unavailableWords('appimage', 'linux')).toContain('Install the .deb package')
    expect(unavailableWords(undefined, 'linux')).toBe('Not available here.')
  })

  it('names the entry main gave in the command to run by hand, the installed package\'s when it gave none', () => {
    expect(linuxCommand('orivon-source.desktop')).toBe('xdg-mime default orivon-source.desktop x-scheme-handler/http x-scheme-handler/https')
    expect(linuxCommand()).toBe('xdg-mime default orivon.desktop x-scheme-handler/http x-scheme-handler/https')
  })
})
