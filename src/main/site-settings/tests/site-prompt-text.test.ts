import { describe, expect, it } from 'vitest'
import { askLines, askView, LOCATION_NOTE, PRIVATE_NOTE, reviewView } from '../site-prompt-text.js'

describe('askLines', () => {
  it.each([
    [['camera'], 'wants to use your camera'],
    [['microphone'], 'wants to use your microphone'],
    [['clipboardRead'], 'wants to see text and images you copied'],
    [['location'], 'wants to know your location'],
    [['midi'], 'wants to use your MIDI devices'],
    [['idle'], 'wants to know when you are away from this computer'],
    [['windowManagement'], 'wants to place windows across your screens'],
    [['notifications'], 'wants to show notifications']
  ] as const)('says what %j wants', (kinds, text) => {
    expect(askLines(kinds, false)).toEqual([{ kinds, text }])
  })

  it('says camera and microphone together, in one line, in either order', () => {
    expect(askLines(['camera', 'microphone'], false)).toEqual([{ kinds: ['camera', 'microphone'], text: 'wants to use your camera and microphone' }])
    expect(askLines(['microphone', 'camera'], false)).toHaveLength(1)
  })

  it('warns that system-exclusive MIDI can reprogram a device', () => {
    expect(askLines(['midi'], true)[0]?.text).toBe('wants to control and reprogram your MIDI devices')
  })

  it('has a fallback line for a kind without wording of its own', () => {
    expect(askLines(['images'], false)[0]?.text).toBe('wants to use images')
  })
})

describe('askView', () => {
  it('names the site, the question and, for location, what the person will actually get', () => {
    expect(askView('abc', 'https://maps.example', ['location'], false, false)).toEqual({
      mode: 'ask', id: 'abc', origin: 'https://maps.example', lines: [{ kinds: ['location'], text: 'wants to know your location' }], locationNote: LOCATION_NOTE, privateNote: null
    })
  })

  it('says the answer is forgotten in a private window', () => {
    expect(askView('abc', 'https://a.example', ['camera'], false, true).privateNote).toBe(PRIVATE_NOTE)
  })

  it('shortens a long host the way every permission question does, keeping the end that decides who it is', () => {
    expect(askView('abc', 'https://a.b.c.d.accounts.example.com', ['camera'], false, false).origin).toMatch(/example\.com$/)
  })
})

describe('reviewView', () => {
  it('carries the rows and whether Site settings can be opened', () => {
    const rows = [{ kind: 'camera' as const, label: 'Camera', value: 'block' as const, askOffered: true }]
    expect(reviewView('https://meet.example', rows, true)).toEqual({ mode: 'review', origin: 'https://meet.example', rows, settingsLink: true })
  })
})
