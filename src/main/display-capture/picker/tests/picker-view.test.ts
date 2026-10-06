import { describe, expect, it } from 'vitest'
import { asPickerCommand, asPickerId } from '../picker-view.js'

describe('asPickerCommand', () => {
  it('accepts exactly the fixed shapes', () => {
    expect(asPickerCommand({ type: 'drawn', id: 'q' })).toEqual({ type: 'drawn', id: 'q' })
    expect(asPickerCommand({ type: 'cancel', id: 'q' })).toEqual({ type: 'cancel', id: 'q' })
    expect(asPickerCommand({ type: 'open-settings', id: 'q' })).toEqual({ type: 'open-settings', id: 'q' })
    expect(asPickerCommand({ type: 'segment', id: 'q', segment: 'window' })).toEqual({ type: 'segment', id: 'q', segment: 'window' })
    expect(asPickerCommand({ type: 'share', id: 'q', card: 'c', audio: false })).toEqual({ type: 'share', id: 'q', card: 'c', audio: false })
  })

  it.each([
    ['nothing', undefined], ['a string', 'share'], ['no id', { type: 'cancel' }], ['an id that is not text', { type: 'cancel', id: 1 }],
    ['an extra key', { type: 'cancel', id: 'q', origin: 'https://evil.example' }], ['an unknown type', { type: 'close', id: 'q' }],
    ['a share with no card', { type: 'share', id: 'q', audio: true }], ['a share with no audio', { type: 'share', id: 'q', card: 'c' }],
    ['a share with audio that is not a boolean', { type: 'share', id: 'q', card: 'c', audio: 'yes' }],
    ['a share with a webContents id', { type: 'share', id: 'q', card: 'c', audio: true, webContentsId: 3 }],
    ['a share with a source id', { type: 'share', id: 'q', card: 'c', audio: true, source: 'screen:0:0' }],
    ['a card that is not text', { type: 'share', id: 'q', card: 4, audio: true }],
    ['a segment that does not exist', { type: 'segment', id: 'q', segment: 'monitor' }], ['a segment with an extra key', { type: 'segment', id: 'q', segment: 'tab', x: 1 }]
  ])('refuses %s', (_name, command) => {
    expect(asPickerCommand(command)).toBeUndefined()
  })
})

describe('asPickerId', () => {
  it('reads only an object that carries nothing but an id', () => {
    expect(asPickerId({ id: 'q' })).toBe('q')
    expect(asPickerId({ id: 'q', extra: 1 })).toBeUndefined()
    expect(asPickerId({ id: 3 })).toBeUndefined()
    expect(asPickerId(undefined)).toBeUndefined()
    expect(asPickerId('q')).toBeUndefined()
  })
})
