import { describe, expect, it } from 'vitest'
import { isAskView, isRestartView, isReviewView, segmentAfterKey } from '../view.js'

const ask = { mode: 'ask', id: 'abc', origin: 'https://a.example', lines: [{ kinds: ['camera'], text: 'wants to use your camera' }], locationNote: null, privateNote: null, allowLabel: 'Allow', restartNote: null, guardMs: 500 }
const review = { mode: 'review', origin: 'https://a.example', settingsLink: false, rows: [{ kind: 'camera', label: 'Camera', value: 'block', askOffered: true, allowOffered: true }] }

describe('isAskView', () => {
  it('accepts what main sends', () => {
    expect(isAskView(ask)).toBe(true)
    expect(isAskView({ ...ask, locationNote: 'note', privateNote: 'note' })).toBe(true)
    expect(isAskView({ ...ask, allowLabel: 'Grant WebGPU', restartNote: 'It restarts.' })).toBe(true)
  })

  it.each([
    ['nothing', undefined], ['a string', 'ask'], ['no id', { ...ask, id: undefined }], ['no lines', { ...ask, lines: [] }],
    ['a line without text', { ...ask, lines: [{ kinds: ['camera'] }] }], ['a line with foreign kinds', { ...ask, lines: [{ kinds: [1], text: 'x' }] }],
    ['no guard length', { ...ask, guardMs: undefined }], ['a review', review], ['a note that is not text', { ...ask, locationNote: true }],
    ['no label for the button', { ...ask, allowLabel: undefined }], ['an empty label', { ...ask, allowLabel: '' }], ['a label that is not text', { ...ask, allowLabel: 7 }],
    ['a restart note that is not text', { ...ask, restartNote: 1 }], ['no restart note', { ...ask, restartNote: undefined }]
  ])('refuses %s', (_name, value) => {
    expect(isAskView(value)).toBe(false)
  })
})

const restart = { mode: 'restart', id: 'abc', line: 'WebGPU starts after Orivon restarts.', note: 'Orivon opens this site again.', guardMs: 500 }

describe('isRestartView', () => {
  it('accepts what main sends', () => {
    expect(isRestartView(restart)).toBe(true)
  })

  it.each([
    ['nothing', undefined], ['a string', 'restart'], ['no id', { ...restart, id: undefined }], ['no line', { ...restart, line: undefined }],
    ['no note', { ...restart, note: 1 }], ['no guard length', { ...restart, guardMs: '500' }], ['an ask', ask], ['a review', review]
  ])('refuses %s', (_name, value) => {
    expect(isRestartView(value)).toBe(false)
  })

  it('is not an ask or a review', () => {
    expect(isAskView(restart)).toBe(false)
    expect(isReviewView(restart)).toBe(false)
  })
})

describe('isReviewView', () => {
  it('accepts what main sends', () => {
    expect(isReviewView(review)).toBe(true)
  })

  it.each([
    ['nothing', null], ['no rows', { ...review, rows: [] }], ['a row with a foreign value', { ...review, rows: [{ ...review.rows[0], value: 'maybe' }] }],
    ['no settings flag', { ...review, settingsLink: undefined }], ['an ask', ask]
  ])('refuses %s', (_name, value) => {
    expect(isReviewView(value)).toBe(false)
  })
})

describe('segmentAfterKey', () => {
  it('moves by arrow and to the ends, without wrapping', () => {
    expect(segmentAfterKey(1, 'ArrowLeft', 3)).toBe(0)
    expect(segmentAfterKey(0, 'ArrowLeft', 3)).toBe(0)
    expect(segmentAfterKey(1, 'ArrowRight', 3)).toBe(2)
    expect(segmentAfterKey(2, 'ArrowRight', 3)).toBe(2)
    expect(segmentAfterKey(1, 'Home', 3)).toBe(0)
    expect(segmentAfterKey(0, 'End', 3)).toBe(2)
    expect(segmentAfterKey(1, 'x', 3)).toBe(1)
  })
})
