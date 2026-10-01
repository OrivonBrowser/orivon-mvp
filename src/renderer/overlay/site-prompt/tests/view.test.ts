import { describe, expect, it } from 'vitest'
import { ARMING_MS, isAskView, isReviewView, segmentAfterKey } from '../view.js'

const ask = { mode: 'ask', id: 'abc', origin: 'https://a.example', lines: [{ kinds: ['camera'], text: 'wants to use your camera' }], locationNote: null, privateNote: null }
const review = { mode: 'review', origin: 'https://a.example', settingsLink: false, rows: [{ kind: 'camera', label: 'Camera', value: 'block', askOffered: true }] }

describe('isAskView', () => {
  it('accepts what main sends', () => {
    expect(isAskView(ask)).toBe(true)
    expect(isAskView({ ...ask, locationNote: 'note', privateNote: 'note' })).toBe(true)
  })

  it.each([
    ['nothing', undefined], ['a string', 'ask'], ['no id', { ...ask, id: undefined }], ['no lines', { ...ask, lines: [] }],
    ['a line without text', { ...ask, lines: [{ kinds: ['camera'] }] }], ['a line with foreign kinds', { ...ask, lines: [{ kinds: [1], text: 'x' }] }],
    ['a review', review], ['a note that is not text', { ...ask, locationNote: true }]
  ])('refuses %s', (_name, value) => {
    expect(isAskView(value)).toBe(false)
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

describe('ARMING_MS', () => {
  it('holds a press back for half a second', () => {
    expect(ARMING_MS).toBe(500)
  })
})
