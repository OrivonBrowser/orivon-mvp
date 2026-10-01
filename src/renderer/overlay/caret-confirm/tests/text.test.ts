import { describe, expect, it } from 'vitest'
import { turnOffText } from '../text.js'

describe('turnOffText', () => {
  it('names the key as it is bound', () => {
    expect(turnOffText(['F7'], 'linux')).toBe('Press F7 to turn it off again.')
    expect(turnOffText(['Ctrl', 'Shift', 'C'], 'win32')).toBe('Press Ctrl+Shift+C to turn it off again.')
  })

  it('writes a Mac chord as its symbols', () => {
    expect(turnOffText(['Cmd', 'Shift', 'C'], 'darwin')).toBe('Press ⌘⇧C to turn it off again.')
  })

  it.each([null, undefined, [], 'F7', [7], ['F7', 1], {}])('points to Settings for %j', (keys) => {
    expect(turnOffText(keys, 'linux')).toBe('You can turn it off again in Settings.')
  })
})
