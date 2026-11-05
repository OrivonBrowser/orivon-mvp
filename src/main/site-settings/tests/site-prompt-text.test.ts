import { describe, expect, it } from 'vitest'
import { askLines, askView, LOCATION_NOTE, PRIVATE_NOTE, RESTART_BLANK_NOTE, RESTART_NOTE, RESTART_RESTORED_NOTE, restartView, reviewView } from '../site-prompt-text.js'

describe('askLines', () => {
  it.each([
    [['camera'], 'wants to use your camera'],
    [['microphone'], 'wants to use your microphone'],
    [['clipboardRead'], 'wants to see text and images you copied'],
    [['location'], 'wants to know your location'],
    [['midi'], 'wants to use your MIDI devices'],
    [['idle'], 'wants to know when you are away from this computer'],
    [['windowManagement'], 'wants to place windows across your screens'],
    [['notifications'], 'wants to show notifications'],
    [['webgpu'], 'wants to use your graphics card for WebGPU']
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
    expect(askView('abc', 'https://maps.example', ['location'], false, false, false, 500)).toEqual({
      mode: 'ask', id: 'abc', origin: 'https://maps.example', lines: [{ kinds: ['location'], text: 'wants to know your location' }], locationNote: LOCATION_NOTE, privateNote: null, allowLabel: 'Allow', restartNote: null, guardMs: 500
    })
  })

  it('says the answer is forgotten in a private window', () => {
    expect(askView('abc', 'https://a.example', ['camera'], false, false, true, 500).privateNote).toBe(PRIVATE_NOTE)
  })

  it('shortens a long host the way every permission question does, keeping the end that decides who it is', () => {
    expect(askView('abc', 'https://a.b.c.d.accounts.example.com', ['camera'], false, false, false, 500).origin).toMatch(/example\.com$/)
  })
})

describe('the WebGPU question', () => {
  const webgpu = (restart: boolean, kinds: readonly ('webgpu' | 'camera')[] = ['webgpu']) => askView('abc', 'https://game.example', kinds, false, restart, false, 500)

  it('says Grant WebGPU on the button that grants, and Allow for every other question', () => {
    expect(webgpu(false).allowLabel).toBe('Grant WebGPU')
    expect(webgpu(true).allowLabel).toBe('Grant WebGPU')
    expect(askView('abc', 'https://a.example', ['camera'], false, false, false, 500).allowLabel).toBe('Allow')
    expect(webgpu(false, ['webgpu', 'camera']).allowLabel).toBe('Allow')
  })

  it('tells what a restart costs only when granting turns the graphics mode on', () => {
    expect(webgpu(true).restartNote).toBe('Orivon restarts to turn WebGPU on. It may use more battery, and on some laptops videos can go blank.')
    expect(webgpu(true).restartNote).toBe(RESTART_NOTE)
    expect(webgpu(false).restartNote).toBeNull()
    expect(askView('abc', 'https://a.example', ['camera'], false, true, false, 500).restartNote).toBeNull()
  })
})

describe('restartView', () => {
  it('says when WebGPU starts and what the restart does to the page and the other tabs', () => {
    expect(restartView('abc', 'site', 500)).toEqual({
      mode: 'restart', id: 'abc', line: 'WebGPU starts after Orivon restarts.', note: 'Orivon opens this site again. Your other tabs and windows are not restored.', guardMs: 500
    })
  })

  it('says the tabs and windows open again when the start-up choice brings them back', () => {
    expect(restartView('abc', 'session', 500)).toEqual({
      mode: 'restart', id: 'abc', line: 'WebGPU starts after Orivon restarts.', note: 'Your tabs and windows open again.', guardMs: 500
    })
    expect(restartView('abc', 'session', 500).note).toBe(RESTART_RESTORED_NOTE)
  })

  it('says nothing of this page opening again when the restart does not reopen it', () => {
    const note = restartView('abc', 'none', 500).note
    expect(note).toBe('Your tabs and windows are not restored.')
    expect(note).toBe(RESTART_BLANK_NOTE)
    expect(note).not.toMatch(/this page/i)
  })
})

describe('reviewView', () => {
  it('carries the rows and whether Site settings can be opened', () => {
    const rows = [{ kind: 'camera' as const, label: 'Camera', value: 'block' as const, askOffered: true, allowOffered: true }]
    expect(reviewView('https://meet.example', rows, true)).toEqual({ mode: 'review', origin: 'https://meet.example', rows, settingsLink: true })
  })
})
